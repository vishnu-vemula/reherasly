import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma, type PaymentOrder, type User } from '@prisma/client';
import prisma from '../config/prisma';
import { checkoutHash, payuCommand, payuConfig, verifyResponseHash } from './billing/payu';
import { activeSubscription } from './postgres-entitlements';

const money = (minor: number) => (minor / 100).toFixed(2);
const minorOf = (value: unknown) => /^\d+(?:\.\d{1,2})?$/.test(String(value ?? '')) ? Math.round(Number(value) * 100) : NaN;
export const contactTag = (value: string) => createHmac('sha256', payuConfig().salt).update(value, 'utf8').digest('hex');
const contactMatches = (actual: string, stored: string | null, tag: string | null) => {
  if (actual === stored) return true;
  if (!tag) return false;
  const a = Buffer.from(contactTag(actual), 'hex');
  const b = Buffer.from(tag, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
const publicApiUrl = () => {
  const value = process.env.API_PUBLIC_URL?.replace(/\/$/, '');
  if (!value || !value.startsWith('https://') && !value.startsWith('http://localhost:')) {
    throw new Error('API_PUBLIC_URL must be an HTTPS URL or localhost');
  }
  return value;
};

export async function createCheckout(user: User, planId: string, idempotencyKey: string, phone: string) {
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(idempotencyKey)) throw new Error('Valid idempotency key required');
  if (!/^\d{10}$/.test(phone)) throw new Error('A 10-digit phone number is required for PayU checkout');
  const config = payuConfig();
  const apiUrl = publicApiUrl();
  const plan = await prisma.plan.findFirst({ where: { id: planId, isPublished: true,
    isArchived: false, currency: 'INR', amountMinor: { gte: 100 }, credits: { gte: 1 }, durationDays: { gte: 1 } } });
  if (!plan) throw new Error('This plan is unavailable for checkout');
  if (await activeSubscription(user.id)) throw new Error('Your current pass is still active');
  let order = await prisma.paymentOrder.findUnique({ where: { idempotencyKey } });
  if (!order) {
    try {
      order = await prisma.paymentOrder.create({ data: {
        userId: user.id, planId, transactionId: `IM${randomBytes(11).toString('hex')}`,
        idempotencyKey, amountMinor: plan.amountMinor, creditLimit: plan.credits,
        durationDays: plan.durationDays, currency: 'INR', productInfo: `Rehearsly ${plan.name}`.slice(0, 100),
        firstName: user.displayName.trim().split(/\s+/)[0].slice(0, 50), email: user.email, phone,
      } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      order = await prisma.paymentOrder.findUnique({ where: { idempotencyKey } });
    }
  }
  if (!order || order.userId !== user.id || order.planId !== planId || order.phone !== phone) {
    throw new Error('Idempotency key belongs to another checkout');
  }
  if (order.status !== 'pending') throw new Error('This checkout is no longer pending');
  const fields = { key: config.key, txnid: order.transactionId, amount: money(order.amountMinor),
    productinfo: order.productInfo!, firstname: order.firstName!, email: order.email!, phone: order.phone!,
    udf1: order.userId, udf2: order.planId,
    surl: `${apiUrl}/api/billing/payu/return`, furl: `${apiUrl}/api/billing/payu/return` };
  return { transactionId: order.transactionId, action: config.checkoutUrl,
    fields: { ...fields, hash: checkoutHash(fields, config.salt) } };
}

async function verifyPayment(transactionId: string) {
  const result = await payuCommand('verify_payment', transactionId);
  const detail = result?.transaction_details?.[transactionId];
  if (Number(result?.status) !== 1 || !detail || typeof detail !== 'object') throw new Error('PayU has not confirmed this payment');
  return detail;
}

const matchesPayment = (order: PaymentOrder, detail: any) => minorOf(detail.transaction_amount ?? detail.amt) === order.amountMinor &&
  String(detail.txnid || order.transactionId) === order.transactionId &&
  String(detail.productinfo || '') === order.productInfo &&
  String(detail.udf1 || '') === order.userId && String(detail.udf2 || '') === order.planId;

/** Provider verification happens before the transaction; order state and grant commit together. */
export async function reconcilePayment(transactionId: string) {
  const observed = await prisma.paymentOrder.findUnique({ where: { transactionId } });
  if (!observed) throw new Error('Unknown transaction');
  if (['refunded', 'refund_pending'].includes(observed.status)) return observed;
  const detail = await verifyPayment(transactionId);
  if (!matchesPayment(observed, detail)) throw new Error('PayU payment details do not match the order');
  const payuId = String(detail.mihpayid || '');
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PaymentOrder" WHERE id = ${observed.id}::uuid FOR UPDATE`;
    const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: observed.id } });
    if (order.status === 'refunded' || order.status === 'refund_pending') return order;
    let current = order;
    if (detail.status === 'success' && detail.unmappedstatus === 'captured' && payuId) {
      if (order.status !== 'success') current = await tx.paymentOrder.update({ where: { id: order.id },
        data: { status: 'success', payuId, failureCode: null } });
      const user = await tx.user.findUnique({ where: { id: order.userId } });
      if (user?.status === 'active' && !user.deletedAt) {
        const start = new Date();
        await tx.subscription.upsert({ where: { orderId: order.id }, update: {}, create: {
          userId: order.userId, planId: order.planId, orderId: order.id, creditLimit: order.creditLimit,
          status: 'active', currentPeriodStart: start,
          currentPeriodEnd: new Date(start.getTime() + order.durationDays * 86_400_000),
        } });
      }
    } else if (['failure', 'failed'].includes(String(detail.status)) && order.status === 'pending') {
      current = await tx.paymentOrder.update({ where: { id: order.id }, data: {
        status: 'failed', failureCode: String(detail.error || 'payment_failed').slice(0, 80),
      } });
    }
    return current;
  });
}

const verifyCallback = async (payload: Record<string, unknown>) => {
  const config = payuConfig();
  if (String(payload.key || '') !== config.key || !verifyResponseHash(payload, config.salt)) {
    throw new Error('Invalid PayU response hash');
  }
  const order = await prisma.paymentOrder.findUnique({ where: { transactionId: String(payload.txnid || '') } });
  if (!order || minorOf(payload.amount) !== order.amountMinor ||
    String(payload.productinfo || '') !== order.productInfo ||
    !contactMatches(String(payload.email || ''), order.email, order.callbackEmailTag) ||
    !contactMatches(String(payload.phone || ''), order.phone, order.callbackPhoneTag) ||
    String(payload.udf1 || '') !== order.userId || String(payload.udf2 || '') !== order.planId) {
    throw new Error('PayU response does not match an order');
  }
  return order;
};

async function recordEvent(eventId: string, eventType: string, payload: Record<string, unknown>) {
  await prisma.paymentEvent.upsert({ where: { provider_providerEventId: { provider: 'payu', providerEventId: eventId } },
    update: {}, create: { provider: 'payu', providerEventId: eventId, eventType, status: 'processed',
      processedAt: new Date(), payload: payload as Prisma.InputJsonValue } });
}

export async function handlePaymentNotification(payload: Record<string, unknown>) {
  const order = await verifyCallback(payload);
  const current = await reconcilePayment(order.transactionId);
  await recordEvent(`payment:${order.transactionId}:${String(payload.status)}:${String(payload.mihpayid || '')}`,
    `payment.${String(payload.status)}`, { transactionId: order.transactionId,
      payuId: String(payload.mihpayid || ''), status: String(payload.status) });
  return current;
}

export async function requestRefund(orderId: string) {
  const order = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
  if (!order?.payuId) throw new Error('Paid order not refundable');
  if (order.status === 'refund_pending') return order;
  if (order.status !== 'success') throw new Error('Paid order not refundable');
  const apiUrl = publicApiUrl();
  const token = `IMR${randomBytes(10).toString('hex')}`;
  const claimed = await prisma.paymentOrder.updateMany({ where: { id: order.id, status: 'success' },
    data: { status: 'refund_pending', refundToken: token } });
  if (!claimed.count) return prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
  let result: any;
  try {
    result = await payuCommand('cancel_refund_transaction', order.payuId,
      { var2: token, var3: money(order.amountMinor), var5: `${apiUrl}/api/billing/payu/webhook` });
  } catch (error) {
    // The provider may have accepted the command before the network failed.
    // Keep refund_pending for reconciliation rather than permitting a second refund.
    throw error;
  }
  if (Number(result?.status) !== 1 && Number(result?.error_code) !== 102) {
    await prisma.paymentOrder.updateMany({ where: { id: order.id, status: 'refund_pending', refundToken: token },
      data: { status: 'success', refundToken: null } });
    throw new Error('PayU did not accept the refund request');
  }
  if (result.request_id) await prisma.paymentOrder.updateMany({ where: { id: order.id, refundToken: token },
    data: { refundRequestId: String(result.request_id) } });
  return prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
}

export async function reconcileRefund(orderId: string) {
  const observed = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
  if (!observed || observed.status !== 'refund_pending') throw new Error('No refund to reconcile');
  let requestId = observed.refundRequestId;
  if (!requestId) {
    if (!observed.payuId || !observed.refundToken) throw new Error('Refund identity is incomplete');
    // PayU can accept a refund when the initiation response is lost or omits
    // request_id. Its PayU-ID lookup lists all actions, so match this exact
    // token, transaction and amount before attaching a recovered request ID.
    const history = await payuCommand('check_action_status', observed.payuId, { var2: 'payuid' });
    const actions = history?.transaction_details?.[observed.payuId];
    if (Number(history?.status) !== 1 || !actions || typeof actions !== 'object')
      throw new Error('PayU refund history is unavailable');
    const matches = Object.entries(actions).filter(([, value]) => {
      const detail = value as Record<string, unknown>;
      return detail && typeof detail === 'object' && String(detail.action || '').toLowerCase() === 'refund' &&
        String(detail.token || '') === observed.refundToken && String(detail.mihpayid || '') === observed.payuId &&
        minorOf(detail.amt) === observed.amountMinor;
    });
    if (matches.length !== 1) throw new Error('PayU refund request could not be uniquely identified');
    requestId = String((matches[0][1] as Record<string, unknown>).request_id || matches[0][0]);
    if (!requestId) throw new Error('PayU refund request ID is unavailable');
    await prisma.paymentOrder.updateMany({ where: { id: orderId, status: 'refund_pending', refundRequestId: null,
      refundToken: observed.refundToken }, data: { refundRequestId: requestId } });
  }
  const result = await payuCommand('check_action_status_txnid', requestId);
  if (Number(result?.status) !== 1) throw new Error('PayU refund status is unavailable');
  const outer = result?.transaction_details?.[requestId];
  const detail = outer?.[requestId] || outer;
  if (String(detail?.token || '') !== observed.refundToken || String(detail?.mihpayid || '') !== observed.payuId ||
    minorOf(detail?.amt) !== observed.amountMinor) throw new Error('Refund status could not be verified');
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PaymentOrder" WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status !== 'refund_pending') return order;
    if (String(detail.status).toLowerCase() === 'success') {
      await tx.subscription.updateMany({ where: { orderId }, data: { status: 'refunded', canceledAt: new Date() } });
      return tx.paymentOrder.update({ where: { id: orderId }, data: { status: 'refunded' } });
    }
    if (String(detail.status).toLowerCase() === 'failure') {
      return tx.paymentOrder.update({ where: { id: orderId }, data: { status: 'success' } });
    }
    return order;
  });
}

export async function handleRefundNotification(payload: Record<string, unknown>) {
  const config = payuConfig();
  if (String(payload.key || '') !== config.key || String(payload.action || '').toLowerCase() !== 'refund') {
    throw new Error('Invalid refund notification');
  }
  const order = await prisma.paymentOrder.findUnique({ where: { transactionId: String(payload.merchantTxnId || '') } });
  if (!order || order.status !== 'refund_pending' || String(payload.token || '') !== order.refundToken ||
    String(payload.mihpayid || '').trim() !== order.payuId || minorOf(payload.amt) !== order.amountMinor) {
    throw new Error('Refund notification does not match an order');
  }
  if (!order.refundRequestId && payload.request_id) {
    await prisma.paymentOrder.updateMany({ where: { id: order.id, refundRequestId: null },
      data: { refundRequestId: String(payload.request_id) } });
  }
  const current = await reconcileRefund(order.id);
  await recordEvent(`refund:${order.refundToken}:${current.status}`, 'refund.status',
    { transactionId: order.transactionId, requestId: current.refundRequestId, status: current.status });
  return current;
}

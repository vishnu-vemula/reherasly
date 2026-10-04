import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { responseHash } from './billing/payu';

const url = process.env.TEST_DATABASE_URL;
test('PostgreSQL PayU checkout, callback, refund and entitlements are idempotent',
  { skip: !url?.endsWith('/interviewmaster_test') }, async () => {
    process.env.DATABASE_URL = url;
    process.env.PAYU_ENV = 'test';
    process.env.PAYU_MERCHANT_KEY = 'merchant';
    process.env.PAYU_MERCHANT_SALT = 'salt';
    process.env.API_PUBLIC_URL = 'http://localhost:5000';
    const db = new PrismaClient();
    const marker = randomUUID();
    const user = await db.user.create({ data: { firebaseUid: marker, email: `${marker}@example.com`, displayName: 'Payment Tester' } });
    const plan = await db.plan.create({ data: { code: `TEST_${marker}`, name: 'Test Pass', description: 'Fixture',
      amountMinor: 12500, currency: 'INR', durationDays: 30, credits: 3, entitlements: { credits: 3 },
    } });
    const originalFetch = globalThis.fetch;
    const { createCheckout, reconcilePayment, handlePaymentNotification, requestRefund } =
      await import('./postgres-billing.js');
    const { reconcileOutstandingOrders } = await import('./postgres-billing-reconciliation.js');
    let verifiedStatus = 'failure';
    let refundToken = '';
    let fields: any;
    let checkoutTransactionId = '';
    globalThis.fetch = async (_url: any, init: any) => {
      const form = init.body as URLSearchParams;
      let data: any;
      if (form.get('command') === 'verify_payment') data = { status: 1, transaction_details: {
        [String(form.get('var1'))]: { txnid: String(form.get('var1')), transaction_amount: '125.00',
          productinfo: fields.productinfo, udf1: fields.udf1, udf2: fields.udf2,
          status: verifiedStatus, unmappedstatus: verifiedStatus === 'success' ? 'captured' : 'failed',
          mihpayid: 'payu-fixture-id' },
      } };
      else if (form.get('command') === 'cancel_refund_transaction') data = { status: 1 };
      else if (form.get('command') === 'check_action_status') {
        assert.equal(form.get('var2'), 'payuid');
        data = { status: 1, transaction_details: { 'payu-fixture-id': {
          'refund-fixture-id': { request_id: 'refund-fixture-id', action: 'refund',
            token: refundToken, mihpayid: 'payu-fixture-id', amt: '125.00', status: 'success' },
        } } };
      }
      else if (form.get('command') === 'check_action_status_txnid') data = { status: 1, transaction_details: {
        'refund-fixture-id': { 'refund-fixture-id': { token: refundToken,
          mihpayid: 'payu-fixture-id', amt: '125.00', status: 'success' } },
      } };
      else throw new Error('Unexpected provider command');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const saved = process.env.PAYU_MERCHANT_SALT;
      delete process.env.PAYU_MERCHANT_SALT;
      await assert.rejects(createCheckout(user, plan.id, `checkout-${marker}`, '9876543210'));
      assert.equal(await db.paymentOrder.count({ where: { userId: user.id } }), 0);
      process.env.PAYU_MERCHANT_SALT = saved;
      const first = await createCheckout(user, plan.id, `checkout-${marker}`, '9876543210');
      checkoutTransactionId = first.transactionId;
      const repeat = await createCheckout(user, plan.id, `checkout-${marker}`, '9876543210');
      assert.equal(first.transactionId, repeat.transactionId);
      fields = first.fields;
      const payload = { ...fields, status: 'success', mihpayid: 'payu-fixture-id', unmappedstatus: 'captured' };
      const callback = { ...payload, hash: responseHash(payload, 'salt') };
      await assert.rejects(handlePaymentNotification({ ...callback, amount: '1.00' }));
      assert.equal(await db.subscription.count({ where: { userId: user.id } }), 0);
      await handlePaymentNotification(callback);
      assert.equal(await db.subscription.count({ where: { userId: user.id } }), 0);
      verifiedStatus = 'success';
      await Promise.all(Array.from({ length: 5 }, () => handlePaymentNotification(callback)));
      assert.equal(await db.subscription.count({ where: { userId: user.id } }), 1);
      assert.equal(await db.paymentEvent.count({ where: { providerEventId: { startsWith: `payment:${first.transactionId}:` } } }), 1);
      const order = await db.paymentOrder.findUniqueOrThrow({ where: { transactionId: first.transactionId } });
      assert.equal(order.status, 'success');
      assert.equal((await db.subscription.findUnique({ where: { orderId: order.id } }))?.creditLimit, 3);
      await reconcilePayment(first.transactionId);
      assert.equal(await db.subscription.count({ where: { userId: user.id } }), 1);
      const refund = await requestRefund(order.id);
      refundToken = refund.refundToken!;
      assert.equal(refund.status, 'refund_pending');
      assert.equal(refund.refundRequestId, null);
      await db.paymentOrder.update({ where: { id: order.id }, data: {
        createdAt: new Date(Date.now() - 8 * 86_400_000) } });
      assert.ok((await reconcileOutstandingOrders()).attempted >= 1);
      assert.equal((await db.paymentOrder.findUnique({ where: { id: order.id } }))?.status, 'refunded');
      assert.equal((await db.paymentOrder.findUnique({ where: { id: order.id } }))?.refundRequestId, 'refund-fixture-id');
      assert.equal((await db.subscription.findUnique({ where: { orderId: order.id } }))?.status, 'refunded');
    } finally {
      globalThis.fetch = originalFetch;
      await db.subscription.deleteMany({ where: { userId: user.id } });
      if (checkoutTransactionId) await db.paymentEvent.deleteMany({ where: { providerEventId: { startsWith: `payment:${checkoutTransactionId}:` } } });
      await db.paymentOrder.deleteMany({ where: { userId: user.id } });
      await db.plan.delete({ where: { id: plan.id } });
      await db.user.delete({ where: { id: user.id } });
      await db.$disconnect();
    }
  });

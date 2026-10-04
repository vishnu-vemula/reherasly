import type { Request, Response } from 'express';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { allowanceFor, activeSubscription } from '../services/postgres-entitlements';
import { createCheckout, handlePaymentNotification, handleRefundNotification, reconcilePayment, reconcileRefund } from '../services/postgres-billing';

const ownerId = (req: Request) => String(req.user?.id || req.user?._id || '');
const checkoutMessages = new Set(['Valid idempotency key required',
  'A 10-digit phone number is required for PayU checkout', 'This plan is unavailable for checkout',
  'Your current pass is still active', 'Idempotency key belongs to another checkout',
  'This checkout is no longer pending']);
const presentOrder = (row: { id: string; transactionId: string; status: string; amountMinor: number; currency: string; createdAt: Date }) => ({
  _id: row.id, transactionId: row.transactionId, status: row.status,
  amountMinor: row.amountMinor, currency: row.currency, createdAt: row.createdAt,
});

export const listPlans = async (_req: Request, res: Response) => {
  const rows = await prisma.plan.findMany({ where: { isPublished: true, isArchived: false,
    currency: 'INR', amountMinor: { gte: 100 } }, orderBy: { amountMinor: 'asc' } });
  res.json({ success: true, plans: rows.map(row => ({
    _id: row.id, id: row.id, code: row.code, name: row.name, description: row.description,
    amountMinor: row.amountMinor, currency: row.currency, durationDays: row.durationDays,
    credits: row.credits, features: row.features,
  })) });
};

export const checkout = async (req: Request, res: Response) => {
  try {
    const planId = String(req.body?.planId || '');
    if (!/^[0-9a-f-]{36}$/i.test(planId)) return res.status(400).json({ success: false, message: 'This plan is unavailable for checkout' });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ownerId(req) } });
    const result = await createCheckout(user, planId, String(req.headers['idempotency-key'] || ''), String(req.body?.phone || ''));
    res.status(201).json({ success: true, ...result });
  } catch (error: any) {
    if (checkoutMessages.has(error?.message)) return res.status(400).json({ success: false, message: error.message });
    logger.error(`PayU checkout failed: ${error?.name || 'Error'}`);
    res.status(503).json({ success: false, message: 'Checkout is temporarily unavailable. Please retry.' });
  }
};

export const me = async (req: Request, res: Response) => {
  const [subscription, orders, allowance] = await Promise.all([
    activeSubscription(ownerId(req)),
    prisma.paymentOrder.findMany({ where: { userId: ownerId(req) }, orderBy: { createdAt: 'desc' }, take: 20 }),
    allowanceFor(ownerId(req)),
  ]);
  res.json({ success: true, subscription: subscription && {
    ...subscription, _id: subscription.id, planId: { ...subscription.plan, _id: subscription.plan.id },
  }, orders: orders.map(presentOrder), allowance });
};

export const orderStatus = async (req: Request, res: Response) => {
  const order = await prisma.paymentOrder.findFirst({ where: {
    transactionId: String(req.params.transactionId), userId: ownerId(req),
  } });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  if (['pending', 'failed', 'success'].includes(order.status)) {
    try { await reconcilePayment(order.transactionId); } catch { /* Provider may not have settled. */ }
  }
  if (order.status === 'refund_pending') {
    try { await reconcileRefund(order.id); } catch { /* Retry later. */ }
  }
  const current = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
  res.json({ success: true, order: presentOrder(current) });
};

export const payuNotification = async (req: Request, res: Response) => {
  try {
    if (String(req.body?.action || '').toLowerCase() === 'refund') await handleRefundNotification(req.body || {});
    else await handlePaymentNotification(req.body || {});
    res.json({ success: true });
  } catch { res.status(400).json({ success: false, message: 'Invalid or unverified payment notification' }); }
};

export const payuReturn = async (req: Request, res: Response) => {
  const transactionId = String(req.body?.txnid || '');
  try { await handlePaymentNotification(req.body || {}); } catch { /* The browser reads verified server state. */ }
  const url = new URL('/billing/result', process.env.CLIENT_URL || 'http://localhost:5173');
  if (transactionId) url.searchParams.set('txnid', transactionId);
  res.redirect(303, url.toString());
};

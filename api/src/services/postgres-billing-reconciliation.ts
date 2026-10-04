import prisma from '../config/prisma';
import logger from '../config/logger';
import { reconcilePayment, reconcileRefund } from './postgres-billing';

const RETRY_MS = 5 * 60_000;
const LEASE_MS = 45_000;
export async function reconcileOutstandingOrders(now = new Date()) {
  const result = { attempted: 0, settled: 0, failed: 0 };
  const cutoff = new Date(now.getTime() - RETRY_MS);
  const recent = new Date(now.getTime() - 7 * 86400000);
  for (let i = 0; i < 20; i++) {
    const candidate = await prisma.paymentOrder.findFirst({ where: {
      OR: [{ createdAt: { gt: recent }, status: { in: ['pending', 'failed'] } },
        { status: 'refund_pending' }],
      AND: [{ OR: [{ lastReconciledAt: null }, { lastReconciledAt: { lte: cutoff } }] },
        { OR: [{ reconcileLeaseUntil: null }, { reconcileLeaseUntil: { lt: now } }] }],
    }, orderBy: [{ lastReconciledAt: 'asc' }, { createdAt: 'asc' }] });
    if (!candidate) break;
    const lease = new Date(now.getTime() + LEASE_MS);
    const claimed = await prisma.paymentOrder.updateMany({ where: { id: candidate.id,
      OR: [{ reconcileLeaseUntil: null }, { reconcileLeaseUntil: { lt: now } }],
      AND: [{ OR: [{ lastReconciledAt: null }, { lastReconciledAt: { lte: cutoff } }] }],
    }, data: { reconcileLeaseUntil: lease, lastReconciledAt: now } });
    if (!claimed.count) continue;
    result.attempted++;
    try { const current = candidate.status === 'refund_pending' ? await reconcileRefund(candidate.id)
      : await reconcilePayment(candidate.transactionId);
      if (current?.status !== candidate.status) result.settled++;
    } catch { result.failed++; }
    finally { await prisma.paymentOrder.updateMany({ where: { id: candidate.id, reconcileLeaseUntil: lease },
      data: { reconcileLeaseUntil: null } }); }
  }
  return result;
}
export function initBillingReconciler() {
  let running = false;
  const timer = setInterval(async () => { if (running) return; running = true;
    try { const result = await reconcileOutstandingOrders();
      if (result.attempted) logger.info(`PayU reconciliation: ${JSON.stringify(result)}`);
    } catch (error: any) { logger.error(`PayU reconciliation scan failed: ${error?.name || 'Error'}`); }
    finally { running = false; }
  }, RETRY_MS);
  timer.unref(); return () => clearInterval(timer);
}

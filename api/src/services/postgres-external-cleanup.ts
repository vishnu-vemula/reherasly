import { JobState, type Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import cloudinary from '../config/cloudinary';
import logger from '../config/logger';
import { deleteFirebaseIdentity } from './firebase-identity.service';

export const CLEANUP_CLOUDINARY = 'cleanup_cloudinary';
export const CLEANUP_FIREBASE = 'cleanup_firebase';

type CleanupPayload = { storageKey?: string; deliveryType?: string; firebaseUid?: string };

export function queueCloudinaryCleanup(tx: Prisma.TransactionClient, resume: {
  id: string; userId: string; storageKey: string; deliveryType: string;
}) {
  return tx.backgroundJob.upsert({
    where: { resourceType_resourceId_kind: { resourceType: 'resume', resourceId: resume.id, kind: CLEANUP_CLOUDINARY } },
    create: { ownerUserId: resume.userId, resourceType: 'resume', resourceId: resume.id,
      kind: CLEANUP_CLOUDINARY, payload: { storageKey: resume.storageKey, deliveryType: resume.deliveryType } },
    update: {},
  });
}

export function queueFirebaseCleanup(tx: Prisma.TransactionClient, userId: string, firebaseUid: string) {
  return tx.backgroundJob.upsert({
    where: { resourceType_resourceId_kind: { resourceType: 'user', resourceId: userId, kind: CLEANUP_FIREBASE } },
    create: { ownerUserId: userId, resourceType: 'user', resourceId: userId,
      kind: CLEANUP_FIREBASE, payload: { firebaseUid } },
    update: {},
  });
}

const runnable = (now: Date, expired: Date): Prisma.BackgroundJobWhereInput => ({ OR: [
  { state: { in: [JobState.queued, JobState.failed] },
    OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
  { state: JobState.running, updatedAt: { lt: expired } },
] });

/** Claim and execute one external side effect. Reclaimed leases make a crash retryable. */
export async function processExternalCleanupJob(id: string): Promise<boolean> {
  const now = new Date();
  const expired = new Date(now.getTime() - 5 * 60_000);
  const claimed = await prisma.backgroundJob.updateMany({
    where: { id, kind: { in: [CLEANUP_CLOUDINARY, CLEANUP_FIREBASE] }, ...runnable(now, expired) },
    data: { state: 'running', attempts: { increment: 1 }, nextAttemptAt: null, errorCode: null },
  });
  if (!claimed.count) return false;
  const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { id } });
  const payload = (job.payload || {}) as CleanupPayload;
  try {
    if (job.kind === CLEANUP_CLOUDINARY) {
      if (!payload.storageKey || !['authenticated', 'private', 'upload'].includes(payload.deliveryType || ''))
        throw new Error('Invalid Cloudinary cleanup payload');
      const result = await cloudinary.uploader.destroy(payload.storageKey,
        { resource_type: 'raw', type: payload.deliveryType as 'authenticated' | 'private' | 'upload' });
      if (!['ok', 'not found'].includes(result.result)) throw new Error('Cloudinary deletion failed');
    } else {
      if (!payload.firebaseUid) throw new Error('Invalid Firebase cleanup payload');
      await deleteFirebaseIdentity(payload.firebaseUid);
    }
    await prisma.backgroundJob.updateMany({ where: { id, state: 'running', attempts: job.attempts },
      data: { state: 'succeeded', errorCode: null, nextAttemptAt: null } });
    return true;
  } catch (error) {
    const wait = Math.min(3_600_000, 5_000 * 2 ** Math.min(job.attempts, 10));
    await prisma.backgroundJob.updateMany({ where: { id, state: 'running', attempts: job.attempts },
      data: { state: 'failed', errorCode: 'external_cleanup_failed',
        nextAttemptAt: new Date(Date.now() + wait) } });
    logger.error(`External cleanup job ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function runExternalCleanupSweep() {
  const now = new Date();
  const rows = await prisma.backgroundJob.findMany({ where: {
    kind: { in: [CLEANUP_CLOUDINARY, CLEANUP_FIREBASE] },
    ...runnable(now, new Date(now.getTime() - 5 * 60_000)),
  }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: 50 });
  for (const row of rows) await processExternalCleanupJob(row.id);
}

export function initExternalCleanupWorker() {
  const timer = setInterval(() => { runExternalCleanupSweep().catch(error =>
    logger.error(`External cleanup sweep failed: ${error instanceof Error ? error.message : String(error)}`)); }, 30_000);
  timer.unref();
  runExternalCleanupSweep().catch(error => logger.error(`External cleanup startup failed: ${error.message}`));
  return () => clearInterval(timer);
}

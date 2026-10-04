import prisma from '../config/prisma';
import AppError from '../utils/app-error';
import { processExternalCleanupJob, queueCloudinaryCleanup } from './postgres-external-cleanup';

/** Commit the row deletion and provider cleanup intent together. */
export async function deletePostgresResume(id: string, ownerUserId?: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new AppError('Resume not found.', 404);
  const jobId = await prisma.$transaction(async tx => {
    const lookup = await tx.resume.findFirst({ where: { id, deletedAt: null,
      ...(ownerUserId ? { userId: ownerUserId } : {}) }, select: { userId: true } });
    if (!lookup) throw new AppError('Resume not found.', 404);
    // Match upload/default selection lock order before touching resume rows.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${lookup.userId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Resume" WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.resume.findFirst({ where: { id, deletedAt: null,
      ...(ownerUserId ? { userId: ownerUserId } : {}) } });
    if (!row) throw new AppError('Resume not found.', 404);
    const interviews = await tx.interview.findMany({ where: { resumeId: id },
      select: { id: true, generationStatus: true, _count: { select: { questions: true } } } });
    if (interviews.some(interview => interview.generationStatus !== 'generated' || !interview._count.questions))
      throw new AppError('Generate the questions for interviews using this resume before deleting it.', 409);
    // Generated questions and session history are self-contained. Drop the
    // relation before deleting the private source file, while retaining only
    // a non-identifying provenance flag for the interview UI.
    for (const interview of interviews) {
      await tx.interview.update({ where: { id: interview.id },
        data: { resumeId: null, resumeSnapshot: { hadResume: true } } });
    }
    const job = await queueCloudinaryCleanup(tx, row);
    await tx.resume.delete({ where: { id } });
    if (row.isDefault) {
      const replacement = await tx.resume.findFirst({ where: { userId: row.userId, deletedAt: null },
        orderBy: { createdAt: 'desc' }, select: { id: true } });
      if (replacement) await tx.resume.update({ where: { id: replacement.id }, data: { isDefault: true } });
    }
    return job.id;
  });
  await processExternalCleanupJob(jobId);
}

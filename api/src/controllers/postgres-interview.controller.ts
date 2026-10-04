import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { Prisma, type Interview, type Question } from '@prisma/client';
import prisma from '../config/prisma';
import AppError from '../utils/app-error';
import { generateInterviewQuestions } from '../services/ai.service';
import { reserveGeneration, releaseGeneration } from '../services/postgres-entitlements';

const ownerId = (req: Request) => String(req.user?.id || req.user?._id || '');
const presentQuestion = (row: Question) => ({
  _id: row.id, id: row.id, questionText: row.prompt, category: row.category,
  difficulty: row.difficulty, expectedKeywords: row.expectedKeywords, order: row.ordinal,
});
const present = (row: Interview & { questions?: Question[]; resume?: { id: string; originalName: string } | null }) => ({
  _id: row.id, id: row.id, userId: row.userId,
  resumeId: row.resume ? { _id: row.resume.id, originalName: row.resume.originalName } : row.resumeId,
  usedResume: Boolean(row.resumeId || (row.resumeSnapshot && typeof row.resumeSnapshot === 'object' &&
    !Array.isArray(row.resumeSnapshot) && (row.resumeSnapshot as Record<string, unknown>).hadResume === true)),
  jobTitle: row.jobTitle, jobDescription: row.jobDescription, company: row.company,
  experienceLevel: row.experienceLevel, questionTypes: row.questionTypes,
  numberOfQuestions: row.questionCount, questions: row.questions?.map(presentQuestion),
  generationStatus: row.generationStatus, generationError: row.errorCode,
  generationStartedAt: row.generationStartedAt,
  status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
});

export const createInterview = async (req: Request, res: Response, next: NextFunction) => {
  const { jobTitle, jobDescription, company, experienceLevel, questionTypes, numberOfQuestions, resumeId } = req.body;
  if (resumeId && !await prisma.resume.findFirst({ where: { id: resumeId, userId: ownerId(req), deletedAt: null } })) {
    return next(new AppError('Resume not found.', 404));
  }
  const row = await prisma.interview.create({ data: {
    userId: ownerId(req), resumeId: resumeId || null, jobTitle, jobDescription,
    company: company || null, experienceLevel: experienceLevel || 'mid',
    questionTypes: questionTypes || ['technical', 'behavioral'], questionCount: Number(numberOfQuestions || 10),
  } });
  res.status(201).json({ success: true, interview: present({ ...row, questions: [] }) });
};

export const generateQuestions = async (req: Request, res: Response, next: NextFunction) => {
  const id = String(req.params.id);
  const row = await prisma.interview.findFirst({ where: { id, userId: ownerId(req) },
    include: { questions: { orderBy: { ordinal: 'asc' } },
      resume: { select: { id: true, originalName: true, extractedText: true } } } });
  if (!row) return next(new AppError('Interview not found.', 404));
  if (row.generationStatus === 'generated' && row.questions.length) {
    return res.json({ success: true, interview: present(row), message: 'Questions already generated.' });
  }
  const attemptId = randomUUID();
  const staleBefore = new Date(Date.now() - 10 * 60_000);
  const claim = await prisma.interview.updateMany({ where: { id, userId: ownerId(req), OR: [
    { generationStatus: { in: ['pending', 'failed'] } },
    { generationStatus: 'generated', questions: { none: {} } },
    { generationStatus: 'generating', generationStartedAt: { lt: staleBefore } },
    { generationStatus: 'generating', generationStartedAt: null },
  ] }, data: { generationStatus: 'generating', generationStartedAt: new Date(), generationAttemptId: attemptId } });
  if (!claim.count) return next(new AppError('Questions are already being generated.', 409));
  try {
    await reserveGeneration(ownerId(req), id);
    const generated = await generateInterviewQuestions({ jobTitle: row.jobTitle,
      jobDescription: row.jobDescription, experienceLevel: row.experienceLevel,
      numberOfQuestions: row.questionCount, resumeText: row.resume?.extractedText || null });
    const final = await prisma.$transaction(async tx => {
      const updated = await tx.interview.updateMany({ where: { id, userId: ownerId(req),
        generationStatus: 'generating', generationAttemptId: attemptId }, data: {
        generationStatus: 'generated', status: 'ready', errorCode: null,
        generationStartedAt: null, generationAttemptId: null,
      } });
      if (!updated.count) throw new AppError('A newer generation attempt is in progress.', 409);
      await tx.question.deleteMany({ where: { interviewId: id } });
      await tx.question.createMany({ data: generated.map((question: any, index: number) => ({
        interviewId: id, ordinal: index, category: String(question.category || 'technical'),
        difficulty: String(question.difficulty || 'medium'), prompt: String(question.questionText),
        expectedKeywords: Array.isArray(question.expectedKeywords) ? question.expectedKeywords.map(String) : [],
        generationVersion: 'v1',
      })) });
      await tx.usageLedgerEntry.updateMany({ where: { idempotencyKey: `generation:${id}`, status: 'reserved' },
        data: { status: 'committed' } });
      return tx.interview.findUniqueOrThrow({ where: { id }, include: { questions: { orderBy: { ordinal: 'asc' } } } });
    });
    res.json({ success: true, message: `${generated.length} questions generated successfully.`, interview: present(final) });
  } catch (error: any) {
    const failed = await prisma.interview.updateMany({ where: { id, userId: ownerId(req),
      generationStatus: 'generating', generationAttemptId: attemptId }, data: {
      generationStatus: 'failed', errorCode: 'generation_failed', generationStartedAt: null, generationAttemptId: null,
    } });
    if (failed.count) await releaseGeneration(id);
    const quota = error?.message === 'Interview allowance exhausted. Choose a plan to continue.';
    next(new AppError(quota ? error.message : 'Question generation failed. Please retry.', quota ? 402 : 503));
  }
};

export const getMyInterviews = async (req: Request, res: Response) => {
  const page = Math.max(1, Math.min(100000, parseInt(String(req.query.page), 10) || 1));
  const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit), 10) || 10));
  const [rows, total] = await Promise.all([
    prisma.interview.findMany({ where: { userId: ownerId(req) }, orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit, take: limit }),
    prisma.interview.count({ where: { userId: ownerId(req) } }),
  ]);
  res.json({ success: true, count: rows.length, total, page, totalPages: Math.ceil(total / limit), interviews: rows.map(present) });
};

export const getInterviewById = async (req: Request, res: Response, next: NextFunction) => {
  const row = await prisma.interview.findFirst({ where: { id: String(req.params.id), userId: ownerId(req) },
    include: { questions: { orderBy: { ordinal: 'asc' } }, resume: { select: { id: true, originalName: true } } } });
  if (!row) return next(new AppError('Interview not found.', 404));
  res.json({ success: true, interview: present(row) });
};

export const deleteInterview = async (req: Request, res: Response, next: NextFunction) => {
  const id = String(req.params.id);
  const row = await prisma.interview.findFirst({ where: { id, userId: ownerId(req) } });
  if (!row) return next(new AppError('Interview not found.', 404));
  if (await prisma.session.count({ where: { interviewId: id } })) return next(new AppError('This interview has session history and cannot be deleted.', 409));
  await prisma.interview.delete({ where: { id } });
  res.json({ success: true, message: 'Interview deleted.' });
};

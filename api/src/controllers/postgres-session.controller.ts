import type { Request, Response, NextFunction } from 'express';
import { Prisma, type Answer, type Interview, type Session } from '@prisma/client';
import prisma from '../config/prisma';
import AppError from '../utils/app-error';
import { evaluateAnswer, generateOverallFeedback } from '../services/ai.service';

const ownerId = (req: Request) => String(req.user?.id || req.user?._id || '');
type Loaded = Session & { answers?: Answer[]; interview?: (Partial<Interview> & {
  questions?: { id: string; category: string }[];
}) | null };
const presentAnswer = (row: Answer) => ({
  _id: row.id, questionId: row.questionId, questionText: row.questionText,
  answerText: row.text, answerAudio: row.answerAudio, timeTaken: row.timeTakenSeconds,
  aiFeedback: row.feedback, aiScore: row.score, skipped: row.skipped,
  followupUsed: row.followupUsed,
});
const present = (row: Loaded) => {
  const feedback = row.feedback && typeof row.feedback === 'object' && !Array.isArray(row.feedback)
    ? row.feedback as Record<string, any> : {};
  return {
    _id: row.id, id: row.id, userId: row.userId,
    interviewId: row.interview ? { _id: row.interview.id, jobTitle: row.interview.jobTitle,
      company: row.interview.company, experienceLevel: row.interview.experienceLevel,
      questions: row.interview.questions?.map(question => ({ _id: question.id, category: question.category })) } : row.interviewId,
    answers: row.answers?.map(presentAnswer), status: row.status,
    startedAt: row.startedAt, completedAt: row.completedAt,
    evaluationStartedAt: row.evaluationStartedAt, totalTimeTaken: row.durationSeconds,
    overallScore: row.overallScore, overallFeedback: feedback.overallFeedback || null,
    strengths: feedback.strengths || [], areasForImprovement: feedback.areasForImprovement || [],
    recommendedResources: feedback.recommendedResources || [],
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
};
const activeStatuses = ['started', 'in_progress', 'evaluating', 'evaluation_failed'] as const;

export const startSession = async (req: Request, res: Response, next: NextFunction) => {
  const interviewId = String(req.body.interviewId || '');
  const interview = await prisma.interview.findFirst({ where: { id: interviewId, userId: ownerId(req) },
    include: { _count: { select: { questions: true } } } });
  if (!interview) return next(new AppError('Interview not found.', 404));
  if (!interview._count.questions) return next(new AppError('Interview questions have not been generated yet.', 400));
  try {
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Interview" WHERE id = ${interviewId}::uuid FOR UPDATE`;
      const existing = await tx.session.findFirst({ where: { userId: ownerId(req), interviewId,
        status: { in: [...activeStatuses] } }, include: { answers: true } });
      if (existing) return { session: existing, resumed: true };
      const session = await tx.session.create({ data: { userId: ownerId(req), interviewId }, include: { answers: true } });
      await tx.interview.update({ where: { id: interviewId }, data: { status: 'in_progress' } });
      return { session, resumed: false };
    });
    res.status(result.resumed ? 200 : 201).json({ success: true, session: present(result.session),
      resumed: result.resumed, ...(!result.resumed && { interview: { _id: interview.id, status: 'in_progress' } }) });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const existing = await prisma.session.findFirst({ where: { userId: ownerId(req), interviewId,
        status: { in: [...activeStatuses] } }, include: { answers: true } });
      if (existing) return res.json({ success: true, session: present(existing), resumed: true });
    }
    next(error);
  }
};

export const submitAnswer = async (req: Request, res: Response, next: NextFunction) => {
  const id = String(req.params.id);
  const questionId = String(req.body.questionId || '');
  const skipped = req.body.skipped === true;
  const text = typeof req.body.answerText === 'string' ? req.body.answerText.trim() : '';
  if (!skipped && !text) return next(new AppError('Write an answer or explicitly skip this question.', 400));
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${id}::uuid FOR UPDATE`;
    const session = await tx.session.findFirst({ where: { id, userId: ownerId(req),
      status: { in: ['started', 'in_progress', 'evaluation_failed'] } } });
    if (!session) return { error: new AppError('Active session not found.', 404) };
    const question = await tx.question.findFirst({ where: { id: questionId, interviewId: session.interviewId } });
    if (!question) return { error: new AppError('Question not found in interview.', 404) };
    await tx.answer.upsert({ where: { sessionId_questionId: { sessionId: id, questionId } },
      // A follow-up is an allowance for this question in this session. Editing
      // or resubmitting the answer must not grant another AI request.
      update: { text: skipped ? '' : text, skipped,
        timeTakenSeconds: Number(req.body.timeTaken || 0), questionText: question.prompt },
      create: { interviewId: session.interviewId, sessionId: id, questionId,
        questionText: question.prompt, text: skipped ? '' : text, skipped,
        timeTakenSeconds: Number(req.body.timeTaken || 0) } });
    const answerCount = await tx.answer.count({ where: { sessionId: id } });
    return { session: await tx.session.update({ where: { id }, data: {
      status: 'in_progress', currentQuestionOrdinal: answerCount,
    }, include: { answers: { orderBy: { submittedAt: 'asc' } } } }) };
  });
  if ('error' in result) return next(result.error);
  res.json({ success: true, message: 'Answer saved.', session: present(result.session) });
};

export const completeSession = async (req: Request, res: Response, next: NextFunction) => {
  const id = String(req.params.id);
  const owner = ownerId(req);
  const existing = await prisma.session.findFirst({ where: { id, userId: owner, status: 'completed' }, include: { answers: true } });
  if (existing) return res.json({ success: true, session: present(existing) });
  const staleBefore = new Date(Date.now() - 10 * 60_000);
  const attemptStartedAt = new Date();
  const claim = await prisma.session.updateMany({ where: { id, userId: owner, OR: [
    { status: { in: ['started', 'in_progress', 'evaluation_failed'] } },
    { status: 'evaluating', evaluationStartedAt: { lt: staleBefore } },
    { status: 'evaluating', evaluationStartedAt: null },
  ] }, data: { status: 'evaluating', evaluationStartedAt: attemptStartedAt } });
  if (!claim.count) return next(new AppError('Session evaluation is already in progress.', 409));
  const session = await prisma.session.findUniqueOrThrow({ where: { id }, include: {
    answers: true, interview: { include: { questions: true } },
  } });
  if (session.interview.userId !== owner) return next(new AppError('Interview not found.', 404));
  const answeredIds = new Set(session.answers.filter(item => item.skipped || item.text.trim()).map(item => item.questionId));
  if (session.interview.questions.some(item => !answeredIds.has(item.id))) {
    await prisma.session.update({ where: { id }, data: { status: 'in_progress', evaluationStartedAt: null } });
    return next(new AppError('Answer or skip every question before finishing.', 400));
  }
  try {
    const graded = await Promise.all(session.answers.map(async item => {
      if (item.skipped || !item.text) return { item, score: 0, feedback: 'Question was skipped.' };
      const question = session.interview.questions.find(q => q.id === item.questionId)!;
      const result = await evaluateAnswer({ questionText: question.prompt, answerText: item.text,
        expectedKeywords: question.expectedKeywords, jobTitle: session.interview.jobTitle });
      if (!Number.isFinite(result.score) || result.score < 0 || result.score > 10) throw new Error('Invalid evaluation');
      return { item, score: Math.round(result.score), feedback: result.feedback || '' };
    }));
    const overallData: any = await generateOverallFeedback({ jobTitle: session.interview.jobTitle,
      answers: graded.map(({ item, score, feedback }) => ({ questionText: item.questionText,
        answerText: item.text, aiScore: score, aiFeedback: feedback })) });
    const calculated = Math.round(graded.reduce((sum, item) => sum + item.score, 0) / (graded.length * 10) * 100);
    const overallScore = Number.isFinite(overallData.overallScore) && overallData.overallScore >= 0 && overallData.overallScore <= 100
      ? Math.round(overallData.overallScore) : calculated;
    const final = await prisma.$transaction(async tx => {
      for (const { item, score, feedback } of graded) await tx.answer.update({ where: { id: item.id },
        data: { score, feedback, evaluationStatus: 'completed' } });
      const changed = await tx.session.updateMany({ where: { id, userId: owner,
        status: 'evaluating', evaluationStartedAt: attemptStartedAt }, data: {
        status: 'completed', evaluationStartedAt: null, completedAt: new Date(), overallScore,
        durationSeconds: graded.reduce((sum, item) => sum + item.item.timeTakenSeconds, 0),
        feedback: { overallFeedback: (overallData.improvementTips || []).join(' '),
          strengths: overallData.strengths || [], areasForImprovement: overallData.weaknesses || [],
          recommendedResources: overallData.improvementTips || [] } as Prisma.InputJsonValue,
      } });
      if (!changed.count) throw new AppError('Session completion changed concurrently.', 409);
      await tx.interview.update({ where: { id: session.interviewId }, data: { status: 'completed' } });
      const completedCount = await tx.session.count({ where: { userId: owner, status: 'completed' } });
      await tx.user.update({ where: { id: owner }, data: { totalSessions: completedCount } });
      return tx.session.findUniqueOrThrow({ where: { id }, include: { answers: true } });
    });
    res.json({ success: true, session: present(final) });
  } catch {
    await prisma.session.updateMany({ where: { id, userId: owner,
      status: 'evaluating', evaluationStartedAt: attemptStartedAt },
      data: { status: 'evaluation_failed', evaluationStartedAt: null } });
    next(new AppError('Evaluation is temporarily unavailable. Your answers are saved; please retry.', 503));
  }
};

export const getMySessions = async (req: Request, res: Response) => {
  const page = Math.max(1, Math.min(100000, parseInt(String(req.query.page), 10) || 1));
  const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit), 10) || 10));
  const [rows, total] = await Promise.all([
    prisma.session.findMany({ where: { userId: ownerId(req) }, orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit, take: limit, include: { interview: true } }),
    prisma.session.count({ where: { userId: ownerId(req) } }),
  ]);
  res.json({ success: true, count: rows.length, total, page, totalPages: Math.ceil(total / limit), sessions: rows.map(present) });
};

export const getSessionById = async (req: Request, res: Response, next: NextFunction) => {
  const row = await prisma.session.findFirst({ where: { id: String(req.params.id), userId: ownerId(req) },
    include: { interview: { include: { questions: { orderBy: { ordinal: 'asc' },
      select: { id: true, category: true } } } },
      answers: { orderBy: { submittedAt: 'asc' } } } });
  if (!row) return next(new AppError('Session not found.', 404));
  const questionOrder = new Map(row.interview.questions.map((question, index) => [question.id, index]));
  const ordered = [...row.answers].sort((a, b) =>
    (questionOrder.get(a.questionId) ?? Infinity) - (questionOrder.get(b.questionId) ?? Infinity));
  res.json({ success: true, session: present({ ...row, answers: ordered }) });
};

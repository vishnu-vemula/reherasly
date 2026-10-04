import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import AppError from '../utils/app-error';
import { deletePostgresResume } from '../services/postgres-resume-deletion';

const paging = (req: Request) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page || 1), 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || 20), 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
};
const person = (u: { id: string; displayName: string; email: string }) => ({ _id: u.id, name: u.displayName, email: u.email });
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const resumeSkills = (parsedData: unknown) => {
  const data = object(parsedData);
  const source = data.skills ?? object(data.resume).skills ?? object(data.Resume).skills ?? object(data.candidate).skills;
  const values: string[] = [];
  const collect = (value: unknown, depth = 0): void => {
    if (value == null || depth > 3 || values.length >= 50) return;
    if (typeof value === 'string') {
      for (const part of value.split(/[,;\n]/)) {
        const skill = part.trim();
        if (skill && skill.length <= 48 && values.length < 50) values.push(skill);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
    } else if (typeof value === 'object') {
      const item = object(value);
      if (typeof item.name === 'string') collect(item.name, depth + 1);
      else if (typeof item.skill === 'string') collect(item.skill, depth + 1);
      else for (const nested of Object.values(item)) collect(nested, depth + 1);
    }
  };
  collect(source);
  return [...new Map(values.map(value => [value.toLowerCase(), value])).values()];
};
export const getAllInterviews = async (req: Request, res: Response) => {
  const { page, limit, skip } = paging(req);
  const [rows, total] = await Promise.all([prisma.interview.findMany({ orderBy: { createdAt: 'desc' },
    skip, take: limit, select: { id: true, jobTitle: true, company: true,
      experienceLevel: true, questionCount: true, status: true, generationStatus: true,
      errorCode: true, createdAt: true,
      user: { select: { id: true, displayName: true, email: true } } } }),
  prisma.interview.count()]);
  res.json({ success: true, data: { interviews: rows.map(row => ({
    _id: row.id, id: row.id, jobTitle: row.jobTitle, company: row.company,
    experienceLevel: row.experienceLevel, numberOfQuestions: row.questionCount,
    status: row.status, generationStatus: row.generationStatus,
    generationError: row.errorCode, createdAt: row.createdAt, userId: person(row.user),
  })),
    total, page, pages: Math.ceil(total / limit) } });
};
export const deleteInterview = async (req: Request, res: Response, next: NextFunction) => {
  const id = String(req.params.id);
  try { await prisma.$transaction(async tx => {
    await tx.usageLedgerEntry.updateMany({ where: { interviewId: id }, data: { interviewId: null } });
    await tx.session.deleteMany({ where: { interviewId: id } });
    await tx.interview.delete({ where: { id } });
  }); res.json({ success: true, message: 'Interview and its sessions deleted.' }); }
  catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')
    return next(new AppError('Interview not found.', 404)); return next(error); }
};
export const getAllSessions = async (req: Request, res: Response) => {
  const { page, limit, skip } = paging(req);
  const [rows, total] = await Promise.all([prisma.session.findMany({ orderBy: { createdAt: 'desc' },
    skip, take: limit, select: { id: true, status: true, overallScore: true, createdAt: true,
      _count: { select: { answers: true } },
      user: { select: { id: true, displayName: true, email: true } },
      interview: { select: { id: true, jobTitle: true, company: true } } } }), prisma.session.count()]);
  res.json({ success: true, data: { sessions: rows.map(row => ({
    _id: row.id, id: row.id, status: row.status, overallScore: row.overallScore,
    createdAt: row.createdAt, answerCount: row._count.answers,
    userId: person(row.user), interviewId: { ...row.interview, _id: row.interview.id },
  })),
    total, page, pages: Math.ceil(total / limit) } });
};
export const deleteSession = async (req: Request, res: Response, next: NextFunction) => {
  try { await prisma.session.delete({ where: { id: String(req.params.id) } });
    res.json({ success: true, message: 'Session deleted.' }); }
  catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')
    return next(new AppError('Session not found.', 404)); return next(error); }
};
export const getAllResumes = async (req: Request, res: Response) => {
  const { page, limit, skip } = paging(req);
  const [rows, total] = await Promise.all([prisma.resume.findMany({ where: { deletedAt: null },
    orderBy: { createdAt: 'desc' }, skip, take: limit,
    select: { id: true, originalName: true, fileName: true, sizeBytes: true,
      parseStatus: true, format: true, createdAt: true, isParsed: true, parsedData: true,
      user: { select: { id: true, displayName: true, email: true } } } }),
  prisma.resume.count({ where: { deletedAt: null } })]);
  res.json({ success: true, data: { resumes: rows.map(row => ({
    _id: row.id, id: row.id, originalName: row.originalName, fileName: row.fileName,
    fileSize: row.sizeBytes, parseStatus: row.parseStatus, format: row.format,
    createdAt: row.createdAt, isParsed: row.isParsed,
    parsedData: { skills: resumeSkills(row.parsedData) }, userId: person(row.user),
  })),
    total, page, pages: Math.ceil(total / limit) } });
};
export const deleteResume = async (req: Request, res: Response, next: NextFunction) => {
  try { await deletePostgresResume(String(req.params.id)); }
  catch (error) { return next(error); }
  res.json({ success: true, message: 'Resume deleted.' });
};

import type { Request, Response, NextFunction } from 'express';
import { Prisma, UserRole, type UserStatus } from '@prisma/client';
import prisma from '../config/prisma';
import AppError from '../utils/app-error';
import { presentUser } from '../services/postgres-identity.service';
import { retirePostgresCandidate } from '../services/postgres-account-deletion';

const adminId = (req: Request) => String(req.admin?.id || req.admin?._id || '');
const pageOf = (value: unknown) => Math.max(1, Math.min(100000, Number.parseInt(String(value), 10) || 1));
const limitOf = (value: unknown) => Math.max(1, Math.min(100, Number.parseInt(String(value), 10) || 20));
const validRole = (value: unknown): value is UserRole => Object.values(UserRole).includes(value as UserRole);

export const getAllUsers = async (req: Request, res: Response) => {
  const page = pageOf(req.query.page);
  const limit = limitOf(req.query.limit);
  const search = String(req.query.search || '').slice(0, 100);
  const where: Prisma.UserWhereInput = {};
  if (search) where.OR = [{ displayName: { contains: search, mode: 'insensitive' } },
    { email: { contains: search, mode: 'insensitive' } }];
  if (req.query.role && req.query.role !== 'all' && validRole(req.query.role)) where.role = req.query.role;
  if (req.query.status === 'premium') where.isPremium = true;
  else if (req.query.status === 'inactive') where.status = 'disabled';
  else if (req.query.status === 'banned') where.status = 'banned';
  else if (req.query.status === 'active') where.status = 'active';
  const sortField = ['createdAt', 'email', 'lastLogin'].includes(String(req.query.sortBy))
    ? String(req.query.sortBy) : req.query.sortBy === 'name' ? 'displayName' : 'createdAt';
  const direction = req.query.sortDir === 'asc' ? 'asc' : 'desc';
  const [users, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy: { [sortField]: direction }, skip: (page - 1) * limit, take: limit }),
    prisma.user.count({ where }),
  ]);
  res.json({ success: true, data: { users: users.map(presentUser), total, page, pages: Math.ceil(total / limit) } });
};

export const getUserById = async (req: Request, res: Response, next: NextFunction) => {
  const id = String(req.params.id);
  const user = await prisma.user.findUnique({ where: { id }, include: {
    // Support staff need resume status and size, not the candidate's extracted
    // text, parsed profile, or private Cloudinary storage identifier.
    resumes: { orderBy: { createdAt: 'desc' }, select: {
      id: true, originalName: true, fileName: true, sizeBytes: true,
      parseStatus: true, createdAt: true,
    } },
    sessions: { orderBy: { createdAt: 'desc' }, take: 50, select: {
      id: true, status: true, overallScore: true, createdAt: true,
      interview: { select: { id: true, jobTitle: true, company: true } },
    } },
  } });
  if (!user) return next(new AppError('User not found.', 404));
  const [interviewCount, sessionCount, resumeCount] = await Promise.all([
    prisma.interview.count({ where: { userId: id } }), prisma.session.count({ where: { userId: id } }),
    prisma.resume.count({ where: { userId: id } }),
  ]);
  res.json({ success: true, data: { user: { ...presentUser(user),
    resumes: user.resumes.map(item => ({ ...item, _id: item.id, fileSize: item.sizeBytes })),
    sessions: user.sessions.map(item => ({ ...item, _id: item.id,
      interviewId: { ...item.interview, _id: item.interview.id } })) },
    interviewCount, sessionCount, resumeCount } });
};

export const updateUser = async (req: Request, res: Response, next: NextFunction) => {
  const id = String(req.params.id);
  const { name, role, isActive, isBanned } = req.body;
  if (role !== undefined && !validRole(role)) return next(new AppError('Invalid role.', 400));
  const data: Prisma.UserUpdateInput = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 50) return next(new AppError('Invalid name.', 400));
    data.displayName = name.trim();
  }
  if (role !== undefined) data.role = role;
  let status: UserStatus | undefined;
  if (isBanned === true) status = 'banned';
  else if (isActive === false) status = 'disabled';
  else if (isBanned === false || isActive === true) status = 'active';
  if (status) data.status = status;
  let updated;
  try { updated = await prisma.$transaction(async tx => {
    // Serialize all staff changes so concurrent requests cannot remove the last super admin.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(918273645)::text`;
    const actor = await tx.user.findUniqueOrThrow({ where: { id: adminId(req) } });
    const target = await tx.user.findUnique({ where: { id } });
    if (!target) throw new AppError('User not found.', 404);
    if (actor.status !== 'active') throw new AppError('Account unavailable.', 403);
    if (role !== undefined && actor.role !== 'super_admin')
      throw new AppError('Only a super admin may assign roles.', 403);
    if (target.role !== 'candidate' && actor.role !== 'super_admin')
      throw new AppError('Staff accounts can only be managed by a super admin.', 403);
    if (target.id === actor.id && (role && role !== 'super_admin' || isActive === false || isBanned === true))
      throw new AppError('You cannot remove your own administrative access.', 403);
    if (target.status === 'deleted') throw new AppError('Deleted accounts cannot be reactivated.', 409);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id}::uuid FOR UPDATE`;
    if (target.role === 'super_admin' && (role && role !== 'super_admin' || status && status !== 'active')) {
      const active = await tx.user.count({ where: { role: 'super_admin', status: 'active' } });
      if (active <= 1) throw new AppError('The last active super admin cannot be removed.', 409);
    }
    return tx.user.update({ where: { id }, data });
  }); } catch (error) { return next(error); }
  res.json({ success: true, user: presentUser(updated) });
};

export const bulkUserAction = async (req: Request, res: Response, next: NextFunction) => {
  const { userIds, action } = req.body;
  if (!Array.isArray(userIds) || !userIds.length || userIds.length > 100 ||
    userIds.some((id: unknown) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) {
    return next(new AppError('Provide at most 100 valid user IDs.', 400));
  }
  if (!['activate', 'deactivate', 'ban', 'unban', 'delete'].includes(action)) return next(new AppError('Invalid bulk action.', 400));
  if (action === 'delete' && req.admin?.role !== 'super_admin') return next(new AppError('Bulk deletion requires a super admin.', 403));
  const users = await prisma.user.findMany({ where: { id: { in: userIds }, role: 'candidate',
    ...(action !== 'delete' && { status: { not: 'deleted' as UserStatus }, deletedAt: null }) } });
  if (!users.length) return next(new AppError('No modifications allowed on protected staff accounts.', 403));
  if (action === 'delete') {
    for (const user of users) await retirePostgresCandidate(user.id, user.firebaseUid);
  } else {
    const status: UserStatus = action === 'ban' ? 'banned' : action === 'deactivate' ? 'disabled' : 'active';
    await prisma.user.updateMany({ where: { id: { in: users.map(item => item.id) },
      role: 'candidate', status: { not: 'deleted' }, deletedAt: null }, data: { status } });
  }
  res.json({ success: true, message: `Bulk ${action} operation completed successfully on ${users.length} users.` });
};

export const deleteUser = async (req: Request, res: Response, next: NextFunction) => {
  const user = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
  if (!user) return next(new AppError('User not found.', 404));
  if (user.role !== 'candidate') return next(new AppError('Staff account retirement requires a separate audited process.', 403));
  await retirePostgresCandidate(user.id, user.firebaseUid);
  res.json({ success: true, message: 'Candidate data removed and account retired; anonymized financial records retained.' });
};

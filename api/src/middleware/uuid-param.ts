import type { Request, Response, NextFunction } from 'express';
import AppError from '../utils/app-error';

/** Reject malformed record IDs before they reach Prisma's UUID columns. */
export default function uuidParam(_req: Request, _res: Response, next: NextFunction, id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return next(new AppError('Invalid identifier.', 400));
  }
  next();
}

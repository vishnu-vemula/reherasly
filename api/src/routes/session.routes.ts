import express from 'express';
const router = express.Router();
import { protectPostgres } from '../middleware/postgres-auth.middleware';
import { body } from 'express-validator';
import validate from '../middleware/validate';
import uuidParam from '../middleware/uuid-param';
import {
  startSession,
  submitAnswer,
  completeSession,
  getMySessions,
  getSessionById,
} from '../controllers/postgres-session.controller';

router.use(protectPostgres);
router.param('id', uuidParam);

router.get('/', getMySessions);
router.post('/start', body('interviewId').isUUID(), validate, startSession);
router.get('/:id', getSessionById);
router.post('/:id/answer', [
  body('questionId').isUUID(),
  body('answerText').optional().isString().isLength({ max: 4000 }),
  body('timeTaken').optional().isInt({ min: 0, max: 86400 }),
  body('skipped').optional().isBoolean({ strict: true }),
], validate, submitAnswer);
router.post('/:id/complete', completeSession);

export default router;

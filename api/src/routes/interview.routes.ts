import express from 'express';
import { body } from 'express-validator';
const router = express.Router();
import { protectPostgres } from '../middleware/postgres-auth.middleware';
import validate from '../middleware/validate';
import uuidParam from '../middleware/uuid-param';
import {
  createInterview,
  generateQuestions,
  getMyInterviews,
  getInterviewById,
  deleteInterview,
} from '../controllers/postgres-interview.controller';

const createValidation = [
  body('jobTitle').trim().isLength({ min: 2, max: 120 }).withMessage('Job title must be 2-120 characters'),
  body('company').optional().trim().isLength({ max: 120 }),
  body('jobDescription').trim().notEmpty().withMessage('Job description is required')
    .isLength({ min: 50, max: 5000 }).withMessage('Job description must be 50-5000 characters'),
  body('resumeId').optional({ values: 'falsy' }).isUUID().withMessage('Invalid resume'),
  body('questionTypes').optional().isArray({ min: 1, max: 5 }).withMessage('Invalid question types'),
  body('questionTypes.*').optional().isIn(['technical', 'behavioral', 'situational', 'hr', 'culture_fit']),
  body('experienceLevel')
    .optional()
    .isIn(['entry', 'mid', 'senior', 'lead', 'executive'])
    .withMessage('Invalid experience level'),
  body('numberOfQuestions')
    .optional()
    .isInt({ min: 3, max: 20 })
    .withMessage('Number of questions must be between 3 and 20'),
];

router.use(protectPostgres);
router.param('id', uuidParam);

router.get('/', getMyInterviews);
router.post('/', createValidation, validate, createInterview);
router.get('/:id', getInterviewById);
router.post('/:id/generate', generateQuestions);
router.delete('/:id', deleteInterview);

export default router;

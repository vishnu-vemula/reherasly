/**
 * routes/admin.routes.js
 *
 * Firebase ID tokens authenticate both candidate and staff requests.
 * Staff authorization uses the current PostgreSQL role and permissions.
 */

import express from 'express';
const router  = express.Router();

import { protectPostgresAdmin as protectAdmin } from '../middleware/postgres-auth.middleware';
import AppError from '../utils/app-error';
import { requirePermission } from '../middleware/rbac';
import prisma from '../config/prisma';
import logger from '../config/logger';
import uuidParam from '../middleware/uuid-param';

const requireSuperAdmin = (req: any, _res: any, next: any) =>
  req.admin?.role === 'super_admin' ? next() : next(new AppError('Super admin required.', 403));

import {
  getAllInterviews,
  deleteInterview,
  getAllSessions,
  deleteSession,
  getAllResumes,
  deleteResume,
} from '../controllers/postgres-admin-content.controller';
import { getStats, getAnalytics, getAllLogs } from '../controllers/postgres-admin-reporting.controller';
import { getAllUsers, getUserById, updateUser, deleteUser, bulkUserAction } from '../controllers/postgres-admin-users.controller';

import {
  createJob,
  getAllJobs,
  getJobStats,
  getJobById,
  updateJob,
  deleteJob,
  bulkJobAction,
} from '../controllers/postgres-admin-jobs.controller';

import {
  getScraperStatus,
  updateScraperSettings,
  triggerManualScrape,
  pauseScraperScheduler,
  resumeScraperScheduler,
  getScraperLogs,
} from '../controllers/postgres-admin-scraper.controller';

import {
  createTemplate,
  getAllTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
} from '../controllers/postgres-admin-templates.controller';

import {
  getAllPrompts,
  getPromptById,
  updatePrompt,
  restorePromptVersion,
} from '../controllers/postgres-admin-prompts.controller';

import {
  createPlan,
  getAllPlans,
  getPlanStats,
  getPlanById,
  updatePlan,
  deletePlan,
} from '../controllers/postgres-admin-plans.controller';

import {
  getAllTransactions,
  refundTransaction,
  reconcileRefundTransaction,
  getPaymentStats,
  getWebhookLogs,
} from '../controllers/postgres-admin-payment.controller';

import {
  getSettings,
  saveSettings,
} from '../controllers/postgres-admin-settings.controller';


// Firebase client sign-in is followed by this database-backed role check.
router.get('/auth/me', protectAdmin, (req, res) => res.json({ success: true,
  admin: req.admin, data: { admin: req.admin } }));

// ── Protected admin routes (require admin or super_admin role) ─────
router.use(protectAdmin);
router.param('id', uuidParam);
router.use(async (req, res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  const actorUserId = String(req.admin?.id || req.admin?._id || '');
  const segments = req.path.split('/').filter(Boolean);
  const category = segments[0] || 'admin';
  try {
    // Persist an intent before any mutation. If the response or process is
    // interrupted, operators can see the unresolved warning in audit logs.
    const event = await prisma.auditEvent.create({ data: { actorUserId,
      action: `${req.method} ${req.path}`, category, status: 'warning',
      details: 'Request started', targetType: category,
      targetId: segments[1] || 'collection' } });
    res.once('finish', () => {
      prisma.auditEvent.update({ where: { id: event.id }, data: {
        status: res.statusCode < 400 ? 'success' : 'failed', details: `HTTP ${res.statusCode}`,
      } }).catch(error => logger.error(`Admin audit completion failed for ${event.id}: ${error.message}`));
    });
    next();
  } catch (error: any) {
    logger.error(`Admin audit intent failed: ${error?.message || 'Error'}`);
    next(new AppError('Admin changes are unavailable while audit logging is down.', 503));
  }
});
router.use('/users', requirePermission('view:users'));
router.use('/jobs', requirePermission('view:jobs'));
router.use('/scraper', requirePermission('view:scraper'));
router.use('/templates', requirePermission('view:templates'));
router.use('/prompts', requirePermission('view:prompts'));
router.use('/plans', requirePermission('view:settings'));
router.use('/payments', requirePermission('view:payments'));
router.use('/settings', requirePermission('view:settings'));
router.use('/analytics', requirePermission('view:analytics'));
router.use('/logs', requirePermission('view:logs'));
router.use(['/interviews', '/sessions', '/resumes', '/stats'], requirePermission('view:analytics'));

// ── Stats ─────────────────────────────────────────────────────────
router.get('/stats', getStats);

// ── Users ─────────────────────────────────────────────────────────
router.get('/users',           getAllUsers);
router.post('/users/bulk',     requirePermission('update:users'), bulkUserAction);
router.get('/users/:id',       getUserById);
router.patch('/users/:id',     requirePermission('update:users'), updateUser);
router.delete('/users/:id',    requireSuperAdmin, deleteUser);   // Super Admin only

// ── Jobs ──────────────────────────────────────────────────────────
router.get('/jobs',            getAllJobs);
router.get('/jobs/stats',      getJobStats);
router.post('/jobs',           requirePermission('create:jobs'), createJob);
router.post('/jobs/bulk',      requirePermission('update:jobs'), bulkJobAction);
router.get('/jobs/:id',        getJobById);
router.patch('/jobs/:id',      requirePermission('update:jobs'), updateJob);
router.delete('/jobs/:id',     requirePermission('delete:jobs'), deleteJob);

// ── Interviews ────────────────────────────────────────────────────
router.get('/interviews',              getAllInterviews);
router.delete('/interviews/:id',       requireSuperAdmin, deleteInterview);

// ── Sessions ──────────────────────────────────────────────────────
router.get('/sessions',                getAllSessions);
router.delete('/sessions/:id',         requireSuperAdmin, deleteSession);

// ── Resumes ───────────────────────────────────────────────────────
router.get('/resumes',                 getAllResumes);
router.delete('/resumes/:id',          requireSuperAdmin, deleteResume);

// ── Scraper Control ───────────────────────────────────────────────
router.get('/scraper/status',          getScraperStatus);
router.patch('/scraper/settings',      requirePermission('update:settings'), updateScraperSettings);
router.post('/scraper/run',            requirePermission('run:scraper'), triggerManualScrape);
router.post('/scraper/pause',          requirePermission('run:scraper'), pauseScraperScheduler);
router.post('/scraper/resume',         requirePermission('run:scraper'), resumeScraperScheduler);
router.get('/scraper/logs',            getScraperLogs);

// ── Interview Templates ───────────────────────────────────────────
router.get('/templates',               getAllTemplates);
router.post('/templates',              requirePermission('create:templates'), createTemplate);
router.get('/templates/:id',           getTemplateById);
router.patch('/templates/:id',         requirePermission('update:templates'), updateTemplate);
router.delete('/templates/:id',        requirePermission('delete:templates'), deleteTemplate);

// ── Prompt Editor Control ─────────────────────────────────────────
router.get('/prompts',                 getAllPrompts);
router.get('/prompts/:id',             getPromptById);
router.patch('/prompts/:id',           requirePermission('update:prompts'), updatePrompt);
router.post('/prompts/:id/restore',    requirePermission('update:prompts'), restorePromptVersion);

// ── Subscription Plans ────────────────────────────────────────────
router.get('/plans',                   getAllPlans);
router.get('/plans/stats',             getPlanStats);
router.post('/plans',                  requirePermission('update:settings'), createPlan);
router.get('/plans/:id',               getPlanById);
router.patch('/plans/:id',             requirePermission('update:settings'), updatePlan);
router.delete('/plans/:id',            requirePermission('update:settings'), deletePlan);

// ── Payment Control ───────────────────────────────────────────────
router.get('/payments/transactions',   getAllTransactions);
router.get('/payments/stats',          getPaymentStats);
router.post('/payments/transactions/:id/refund', requirePermission('refund:payments'), refundTransaction);
router.post('/payments/transactions/:id/reconcile', requirePermission('refund:payments'), reconcileRefundTransaction);
router.get('/payments/webhooks',       getWebhookLogs);

// ── Settings Control ──────────────────────────────────────────────
router.get('/settings',                getSettings);
router.patch('/settings',              requirePermission('update:settings'), saveSettings);

// ── Analytics Control ─────────────────────────────────────────────
router.get('/analytics/stats',         getAnalytics);

// ── Audit Log Control ─────────────────────────────────────────────
router.get('/logs',                    getAllLogs);

export default router;

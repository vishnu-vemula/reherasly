/**
 * app.js — Pure Express application (no server.listen here)
 *
 * Separation of concerns:
 *  - app.js  → Express app, middleware, routes (testable in isolation)
 *  - server.js → HTTP server bootstrap, process event handlers
 */

import 'express-async-errors';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import compression from 'compression';
import prisma from './config/prisma';
import { getClient } from './config/redis';
import { firebaseIsReady } from './services/firebase-identity.service';
import requestLogger from './middleware/request-logger';
import errorHandler from './middleware/error-handler';
// Route Imports
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import resumeRoutes from './routes/resume.routes';
import interviewRoutes from './routes/interview.routes';
import sessionRoutes from './routes/session.routes';
import jobsRoutes from './routes/jobs.routes';
import adminRoutes from './routes/admin.routes';
import billingRoutes from './routes/billing.routes';
const app = express();

// Only trust the explicitly configured number of reverse proxies. Trusting all
// forwarded addresses lets callers choose their own rate-limit identity.
const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 5) {
  throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5');
}
app.set('trust proxy', trustedProxyHops);

const rateLimitStore = (prefix: string) => process.env.REDIS_ENABLED === 'false'
  ? undefined
  : new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: async (...args: string[]) => {
      const client = getClient()?.native;
      if (!client?.isReady) throw new Error('Redis rate-limit store unavailable');
      return client.sendCommand(args);
    },
  });

// ─── Security Headers ─────────────────────────────────────────────
app.use(helmet());

// ─── Gzip Compression ─────────────────────────────────────────────
// Compresses all JSON/text responses above the threshold.
// Skips already-encoded content (images, pre-gzipped assets).
app.use(compression({
  // Only compress responses larger than this (bytes). Default 1KB.
  threshold: parseInt(process.env.COMPRESSION_THRESHOLD_BYTES, 10) || 1024,
  // zlib compression level: 1 (fast) – 9 (best). 6 = balanced default.
  level: parseInt(process.env.COMPRESSION_LEVEL, 10) || 6,
  filter(req, res) {
    // Honour the caller's opt-out header
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));

// ─── CORS ─────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    const allowed = process.env.CLIENT_URL || 'http://localhost:5173';
    // Let local dev and exact matches through instantly
    if (!origin || origin === allowed) return callback(null, true);
    
    // Normalize both for comparison (remove trailing slashes)
    const normalizedOrigin  = origin.replace(/\/$/, '');
    const normalizedAllowed = allowed.replace(/\/$/, '');

    if (normalizedOrigin === normalizedAllowed) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Rejected origin: ${origin} (Expected: ${allowed})`);
      callback(null, false); // Don't throw error, just deny CORS
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'Accept', 'Idempotency-Key'],
}));

// Authenticated API responses include profiles, resumes and payment state.
// Do not leave those responses in browser or intermediary caches.
app.use('/api', (req, res, next) => {
  if (req.headers.authorization) res.set('Cache-Control', 'no-store');
  next();
});


// ─── Rate Limiting ─────────────────────────────────────────────────
app.use('/api/', rateLimit({
  skip: (req) => req.path === '/billing/payu/webhook' || req.path === '/billing/payu/return',
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)        || 100,
  store: rateLimitStore('api'),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
}));

// PayU callbacks bypass the ordinary API quota so provider retries are not
// blocked by customer traffic, but still need a bounded public request rate.
app.use('/api/billing/payu', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  store: rateLimitStore('payu'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many payment notifications.' },
}));

// ─── Body Parsers ──────────────────────────────────────────────────
// PayU callbacks are public endpoints. Parse them with a small limit before
// the general API parser so a forged callback cannot consume 10 MB per call.
app.use('/api/billing/payu', express.json({ limit: '32kb' }), express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '10mb', verify: (req, _res, body) => { (req as any).rawBody = body; } }));
app.use(express.urlencoded({ extended: false, limit: '10mb', verify: (req, _res, body) => { (req as any).rawBody = body; } }));

// ─── HTTP Request Logging ──────────────────────────────────────────
// Two layers:
//  1. requestLogger — structured Winston logs (console + files) for
//     EVERY request: method, path, status, duration, caller IP and
//     authenticated user id when present. Levels scale with status.
app.use(requestLogger);

// ─── Health Check ──────────────────────────────────────────────────
app.get('/api/health', (_req, res) =>
  res.status(200).json({ success: true, message: 'OK', timestamp: new Date().toISOString() })
);
app.get('/api/ready', async (_req, res) => {
  const postgres = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
  const redis = process.env.REDIS_ENABLED === 'false' ? process.env.NODE_ENV !== 'production' : Boolean(getClient()?.native.isReady);
  const payu = Boolean(process.env.PAYU_MERCHANT_KEY && process.env.PAYU_MERCHANT_SALT && ['test', 'production'].includes(process.env.PAYU_ENV || ''));
  const firebase = await firebaseIsReady();
  const ready = postgres && redis && payu && firebase;
  res.status(ready ? 200 : 503).json({ success: ready, services: { postgres, redis, payu, firebase } });
});

// ─── API Routes ────────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/users',      userRoutes);
app.use('/api/resumes',    resumeRoutes);
app.use('/api/interviews', interviewRoutes);
app.use('/api/sessions',   sessionRoutes);
app.use('/api/jobs',       jobsRoutes);
app.use('/api/admin',      adminRoutes);
app.use('/api/billing',    billingRoutes);

// ─── 404 Catch-all ────────────────────────────────────────────────
app.use('*', (req, res) =>
  res.status(404).json({ success: false, message: 'Endpoint not found.' })
);

// ─── Global Error Handler (must be last) ──────────────────────────
app.use(errorHandler);

export default app;

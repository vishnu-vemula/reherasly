import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { PrismaClient } from '@prisma/client';
import { io as socketClient } from 'socket.io-client';
import initPostgresSocket from '../postgres-socket';
import { resolvePostgresUser } from './postgres-identity.service';

const url = process.env.TEST_DATABASE_URL;
const enabled = Boolean(url?.endsWith('/interviewmaster_test') && process.env.FIREBASE_AUTH_EMULATOR_HOST);
test('Socket.IO rejects requests from an unapproved browser origin before authentication', async () => {
  process.env.CLIENT_URL = 'http://localhost:5173';
  const server = createServer();
  const io = initPostgresSocket(server);
  await new Promise<void>(done => server.listen(0, done));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind');
    const response = await fetch(`http://127.0.0.1:${address.port}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: 'https://unapproved.example' },
    });
    assert.equal(response.status, 403);
  } finally {
    await new Promise<void>(done => io.close(() => done()));
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});
test('Socket.IO accepts Firebase ID tokens and denies banned users and cross-user records in PostgreSQL',
  { skip: !enabled }, async () => {
    process.env.DATABASE_URL = url;
    process.env.CLIENT_URL = 'http://localhost:5173';
    if (!getApps().length) initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'demo-interviewmaster' });
    const firebase = getAuth();
    const db = new PrismaClient();
    const marker = randomUUID();
    const password = 'StrongPassword123!';
    const created: string[] = [];
    const makeIdentity = async (label: string) => {
      const email = `${label}-${marker}@example.com`;
      const identity = await firebase.createUser({ email, password, emailVerified: true });
      created.push(identity.uid);
      const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      });
      assert.equal(response.status, 200);
      const token = (await response.json()).idToken as string;
      return { token, user: (await resolvePostgresUser(token, true)).user };
    };
    const server = createServer();
    const io = initPostgresSocket(server);
    await new Promise<void>(done => server.listen(0, done));
    try {
      const owner = await makeIdentity('owner');
      const other = await makeIdentity('other');
      const interview = await db.interview.create({ data: { userId: other.user.id,
        jobTitle: 'Engineer', jobDescription: 'Private job', experienceLevel: 'mid', questionCount: 1,
        questions: { create: { ordinal: 0, category: 'technical', difficulty: 'medium',
          prompt: 'Private question?', expectedKeywords: [], generationVersion: 'test' } },
      }, include: { questions: true } });
      const session = await db.session.create({ data: { userId: other.user.id, interviewId: interview.id } });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Server did not bind');
      const base = `http://127.0.0.1:${address.port}`;
      const connect = (token: string) => socketClient(base, { auth: { token }, transports: ['websocket'], reconnection: false });
      const denied = connect('invalid-token');
      try {
        const error = await new Promise<Error>((done, reject) => {
          denied.once('connect_error', done); setTimeout(() => reject(new Error('Socket was accepted')), 3000);
        });
        assert.match(error.message, /Authentication required/);
      } finally { denied.disconnect(); }
      const candidate = connect(owner.token);
      try {
        await new Promise<void>((done, reject) => { candidate.once('connect', done); candidate.once('connect_error', reject); });
        const rejected = new Promise<string>((done, reject) => {
          candidate.once('ai_error', done); setTimeout(() => reject(new Error('Cross-user socket request was accepted')), 3000);
        });
        candidate.emit('live_answer', { interviewId: interview.id, sessionId: session.id,
          questionId: interview.questions[0].id, answerText: 'Private answer' });
        assert.match(await rejected, /unavailable|already been used/i);
      } finally { candidate.disconnect(); }
      await db.user.update({ where: { id: owner.user.id }, data: { status: 'banned' } });
      const banned = connect(owner.token);
      try {
        const error = await new Promise<Error>((done, reject) => {
          banned.once('connect_error', done); setTimeout(() => reject(new Error('Banned socket was accepted')), 3000);
        });
        assert.match(error.message, /Authentication required/);
      } finally { banned.disconnect(); }
    } finally {
      await new Promise<void>(done => io.close(() => done()));
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      await db.user.deleteMany({ where: { firebaseUid: { in: created } } });
      await Promise.allSettled(created.map(uid => firebase.deleteUser(uid)));
      await db.$disconnect();
    }
  });

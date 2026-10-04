import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { PrismaClient } from '@prisma/client';
import groq from '../config/groq';
import { protectPostgres } from '../middleware/postgres-auth.middleware';
import { resolvePostgresUser } from './postgres-identity.service';
import * as interviews from '../controllers/postgres-interview.controller';
import * as sessions from '../controllers/postgres-session.controller';

const url = process.env.TEST_DATABASE_URL;
const enabled = Boolean(url?.endsWith('/interviewmaster_test') && process.env.FIREBASE_AUTH_EMULATOR_HOST);
test('Firebase + PostgreSQL candidate interview/session journey preserves quota and ownership',
  { skip: !enabled }, async () => {
    process.env.DATABASE_URL = url;
    process.env.OPENAI_API_KEY = '';
    if (!getApps().length) initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'demo-interviewmaster' });
    const firebase = getAuth();
    const db = new PrismaClient();
    const marker = randomUUID();
    const password = 'StrongPassword123!';
    const created: string[] = [];
    const makeIdentity = async (label: string) => {
      const email = `${label}-${marker}@example.com`;
      const user = await firebase.createUser({ email, password, emailVerified: true });
      created.push(user.uid);
      const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      });
      assert.equal(response.status, 200);
      const token = (await response.json()).idToken as string;
      const { user: appUser } = await resolvePostgresUser(token, true);
      return { token, appUser };
    };
    const originalAI = groq.chat.completions.create;
    let malformedQuestions = true;
    let malformedEvaluation = true;
    (groq.chat.completions as any).create = async (input: any) => {
      const prompt = input.messages.map((item: any) => item.content).join('\n');
      let output: any;
      if (prompt.includes('Generate:\n-')) output = malformedQuestions
        ? { technical: [{ questionText: 'bad' }] }
        : { technical: [
          { questionText: 'How would you design a reliable API?', difficulty: 'medium', expectedKeywords: ['reliability'] },
          { questionText: 'How do transactions prevent duplicate writes?', difficulty: 'medium', expectedKeywords: ['transactions'] },
        ], behavioral: [{ questionText: 'Describe a difficult team decision?', difficulty: 'medium', expectedKeywords: ['decision'] }] };
      else if (prompt.includes("Candidate's Answer:")) output = malformedEvaluation
        ? { score: 'invalid' } : { score: 7, feedback: 'Good explanation.' };
      else if (prompt.includes('Interview Summary:')) output = { overallScore: 70,
        strengths: ['Clear explanations'], weaknesses: ['More examples'], improvementTips: ['Practice'] };
      else throw new Error('Unexpected AI call');
      return { choices: [{ message: { content: JSON.stringify(output) } }] };
    };
    const app = express();
    app.use(express.json());
    app.get('/interviews/:id', protectPostgres, interviews.getInterviewById);
    app.post('/interviews', protectPostgres, interviews.createInterview);
    app.post('/interviews/:id/generate', protectPostgres, interviews.generateQuestions);
    app.post('/sessions/start', protectPostgres, sessions.startSession);
    app.post('/sessions/:id/answer', protectPostgres, sessions.submitAnswer);
    app.post('/sessions/:id/complete', protectPostgres, sessions.completeSession);
    app.get('/sessions/:id', protectPostgres, sessions.getSessionById);
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));
    const server = app.listen(0);
    try {
      const owner = await makeIdentity('owner');
      const other = await makeIdentity('other');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Server did not bind');
      const base = `http://127.0.0.1:${address.port}`;
      const request = (path: string, token: string, data?: unknown, method = 'POST') => fetch(`${base}${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(data !== undefined && { body: JSON.stringify(data) }),
      });
      let response = await request('/interviews', owner.token, { jobTitle: 'Engineer',
        jobDescription: 'Design reliable APIs with transaction safety, automated tests and clear error handling.',
        numberOfQuestions: 3 });
      assert.equal(response.status, 201);
      const interviewId = (await response.json()).interview.id;
      response = await request(`/interviews/${interviewId}`, other.token, undefined, 'GET');
      assert.equal(response.status, 404);
      response = await request(`/interviews/${interviewId}/generate`, owner.token);
      assert.equal(response.status, 503);
      assert.equal((await db.usageCounter.findFirst({ where: { userId: owner.appUser.id } }))?.units, 0);
      // Repair an inconsistent imported row marked generated without questions.
      await db.interview.update({ where: { id: interviewId }, data: { generationStatus: 'generated' } });
      malformedQuestions = false;
      response = await request(`/interviews/${interviewId}/generate`, owner.token);
      assert.equal(response.status, 200);
      const questions = (await response.json()).interview.questions;
      assert.equal(questions.length, 3);
      response = await request(`/interviews/${interviewId}/generate`, owner.token);
      assert.equal(response.status, 200);
      assert.equal((await db.usageCounter.findFirst({ where: { userId: owner.appUser.id } }))?.units, 1);
      const starts = await Promise.all(Array.from({ length: 5 }, () => request('/sessions/start', owner.token, { interviewId })));
      assert.equal(starts.filter(item => item.status === 201).length, 1);
      const startBodies = await Promise.all(starts.map(item => item.json()));
      const sessionId = startBodies[0].session.id;
      assert.ok(startBodies.every(item => item.session.id === sessionId));
      await db.session.update({ where: { id: sessionId }, data: {
        status: 'evaluating', evaluationStartedAt: new Date() } });
      response = await request('/sessions/start', owner.token, { interviewId });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).session.status, 'evaluating');
      await db.session.update({ where: { id: sessionId }, data: {
        status: 'in_progress', evaluationStartedAt: null } });
      response = await request(`/sessions/${sessionId}`, other.token, undefined, 'GET');
      assert.equal(response.status, 404);
      response = await request(`/sessions/${sessionId}/complete`, owner.token);
      assert.equal(response.status, 400);
      for (const question of [...questions].reverse()) {
        response = await request(`/sessions/${sessionId}/answer`, owner.token,
          { questionId: question.id, answerText: 'I would use transactions and retries.', timeTaken: 10 });
        assert.equal(response.status, 200);
      }
      await db.answer.update({ where: { sessionId_questionId: { sessionId, questionId: questions[0].id } },
        data: { followupUsed: true } });
      response = await request(`/sessions/${sessionId}/answer`, owner.token,
        { questionId: questions[0].id, answerText: 'I would use transactions and retries.', timeTaken: 11 });
      assert.equal(response.status, 200);
      response = await request(`/sessions/${sessionId}/answer`, owner.token,
        { questionId: questions[0].id, answerText: 'I would use transactions, retries, and idempotency.', timeTaken: 12 });
      assert.equal(response.status, 200);
      assert.equal((await db.answer.findUnique({ where: { sessionId_questionId: {
        sessionId, questionId: questions[0].id } } }))?.followupUsed, true);
      response = await request(`/sessions/${sessionId}/complete`, owner.token);
      assert.equal(response.status, 503);
      malformedEvaluation = false;
      response = await request(`/sessions/${sessionId}/complete`, owner.token);
      assert.equal(response.status, 200);
      response = await request(`/sessions/${sessionId}/complete`, owner.token);
      assert.equal(response.status, 200);
      assert.equal((await db.user.findUnique({ where: { id: owner.appUser.id } }))?.totalSessions, 1);
      response = await request(`/sessions/${sessionId}`, owner.token, undefined, 'GET');
      assert.equal(response.status, 200);
      const report = (await response.json()).session;
      assert.equal(report.interviewId.questions.length, 3);
      assert.ok(report.interviewId.questions.every((question: any) => question.category));
      assert.deepEqual(report.answers.map((answer: any) => answer.questionId), questions.map((question: any) => question.id));
    } finally {
      (groq.chat.completions as any).create = originalAI;
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      await db.user.deleteMany({ where: { firebaseUid: { in: created } } });
      await Promise.allSettled(created.map(uid => firebase.deleteUser(uid)));
      await db.$disconnect();
    }
  });

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { PrismaClient } from '@prisma/client';
import { protectPostgresAdmin } from '../middleware/postgres-auth.middleware';
import { requirePermission } from '../middleware/rbac';
import { resolvePostgresUser } from './postgres-identity.service';
import * as users from '../controllers/postgres-admin-users.controller';
import * as jobs from '../controllers/postgres-admin-jobs.controller';
import * as content from '../controllers/postgres-admin-content.controller';

const url = process.env.TEST_DATABASE_URL;
const enabled = Boolean(url?.endsWith('/interviewmaster_test') && process.env.FIREBASE_AUTH_EMULATOR_HOST);
test('current PostgreSQL role and status control admin APIs without client role claims',
  { skip: !enabled }, async () => {
    process.env.DATABASE_URL = url;
    process.env.REDIS_ENABLED = 'false';
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
    const app = express();
    app.use(express.json());
    app.get('/users', protectPostgresAdmin, requirePermission('view:users'), users.getAllUsers);
    app.get('/users/:id', protectPostgresAdmin, requirePermission('view:users'), users.getUserById);
    app.post('/users/bulk', protectPostgresAdmin, requirePermission('update:users'), users.bulkUserAction);
    app.get('/resumes', protectPostgresAdmin, requirePermission('view:analytics'), content.getAllResumes);
    app.patch('/users/:id', protectPostgresAdmin, requirePermission('update:users'), users.updateUser);
    app.get('/jobs', protectPostgresAdmin, requirePermission('view:jobs'), jobs.getAllJobs);
    app.post('/jobs', protectPostgresAdmin, requirePermission('create:jobs'), jobs.createJob);
    app.patch('/jobs/:id', protectPostgresAdmin, requirePermission('update:jobs'), jobs.updateJob);
    app.delete('/jobs/:id', protectPostgresAdmin, requirePermission('delete:jobs'), jobs.deleteJob);
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));
    const server = app.listen(0);
    try {
      const superAdmin = await makeIdentity('super');
      const candidate = await makeIdentity('candidate');
      const privateCandidate = await makeIdentity('private');
      await db.user.update({ where: { id: superAdmin.user.id }, data: { role: 'super_admin' } });
      await db.resume.create({ data: { userId: privateCandidate.user.id,
        storageKey: `private-${marker}`, originalName: 'candidate.pdf',
        contentType: 'application/pdf', sizeBytes: 123, extractedText: 'private resume text',
        parsedData: { skills: ['React'], secret: 'private parsed detail' }, isParsed: true,
        parseStatus: 'parsed' } });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Server did not bind');
      const base = `http://127.0.0.1:${address.port}`;
      const request = (path: string, token: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      let response = await request('/users', candidate.token);
      assert.equal(response.status, 403);
      response = await request(`/users/${privateCandidate.user.id}`, superAdmin.token);
      assert.equal(response.status, 200);
      const userDetail = await response.text();
      assert.ok(!userDetail.includes('private resume text'));
      assert.ok(!userDetail.includes('private parsed detail'));
      assert.ok(!userDetail.includes(`private-${marker}`));
      response = await request('/resumes', superAdmin.token);
      assert.equal(response.status, 200);
      const resumeList = await response.text();
      assert.ok(resumeList.includes('React'));
      assert.ok(!resumeList.includes('private resume text'));
      assert.ok(!resumeList.includes('private parsed detail'));
      assert.ok(!resumeList.includes(`private-${marker}`));
      response = await request(`/users/${candidate.user.id}`, superAdmin.token, 'PATCH', { role: 'support' });
      assert.equal(response.status, 200, await response.text());
      response = await request('/users', candidate.token);
      assert.equal(response.status, 200);
      response = await request('/jobs', candidate.token, 'POST', {
        title: 'Platform Engineer', company: 'Fixture', description: 'Build APIs', applyUrl: 'https://example.com/apply',
      });
      assert.equal(response.status, 403);
      response = await request(`/users/${candidate.user.id}`, superAdmin.token, 'PATCH', { role: 'content_manager' });
      assert.equal(response.status, 200);
      response = await request('/jobs', candidate.token, 'POST', {
        title: 'Platform Engineer', company: 'Fixture', description: 'Build APIs', applyUrl: 'http://unsafe.example/apply',
      });
      assert.equal(response.status, 400);
      response = await request('/jobs', candidate.token, 'POST', {
        title: 'Platform Engineer', company: 'Fixture', description: 'Build APIs', applyUrl: 'https://example.com/apply',
      });
      assert.equal(response.status, 201);
      const jobId = (await response.json()).job.id;
      response = await request('/jobs', candidate.token);
      assert.equal(response.status, 200);
      assert.ok((await response.json()).data.jobs.some((item: any) => item.id === jobId));
      response = await request(`/jobs/${jobId}`, candidate.token, 'PATCH', { isPinned: true });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).job.isPinned, true);
      response = await request(`/jobs/${jobId}`, candidate.token, 'DELETE');
      assert.equal(response.status, 200);
      response = await request(`/users/${superAdmin.user.id}`, superAdmin.token, 'PATCH', { role: 'candidate' });
      assert.equal(response.status, 403);
      await db.user.update({ where: { id: privateCandidate.user.id }, data: {
        status: 'deleted', deletedAt: new Date() } });
      response = await request('/users/bulk', superAdmin.token, 'POST', {
        userIds: [privateCandidate.user.id], action: 'activate',
      });
      assert.equal(response.status, 403);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: privateCandidate.user.id } })).status, 'deleted');
      await db.user.update({ where: { id: candidate.user.id }, data: { status: 'banned' } });
      response = await request('/users', candidate.token);
      assert.equal(response.status, 403);
      response = await request('/users', 'invalid-token');
      assert.equal(response.status, 401);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      await db.jobListing.deleteMany({ where: { postedById: { in: (await db.user.findMany({ where: { firebaseUid: { in: created } }, select: { id: true } })).map(item => item.id) } } });
      await db.user.deleteMany({ where: { firebaseUid: { in: created } } });
      await Promise.allSettled(created.map(uid => firebase.deleteUser(uid)));
      await db.$disconnect();
    }
  });

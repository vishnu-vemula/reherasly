import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { PrismaClient } from '@prisma/client';
import cloudinary from '../config/cloudinary';
import groq from '../config/groq';
import upload from '../middleware/upload.middleware';
import { protectPostgres } from '../middleware/postgres-auth.middleware';
import { resolvePostgresUser } from './postgres-identity.service';
import * as resumes from '../controllers/postgres-resume.controller';
import { processExternalCleanupJob } from './postgres-external-cleanup';

const url = process.env.TEST_DATABASE_URL;
const enabled = Boolean(url?.endsWith('/interviewmaster_test') && process.env.FIREBASE_AUTH_EMULATOR_HOST);
test('PostgreSQL resume upload and download enforce Firebase UID ownership',
  { skip: !enabled }, async () => {
    process.env.DATABASE_URL = url;
    process.env.CLIENT_URL = 'http://localhost:5173';
    if (!getApps().length) initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'demo-interviewmaster' });
    const firebase = getAuth();
    const db = new PrismaClient();
    const marker = randomUUID();
    const password = 'StrongPassword123!';
    const originals = { upload: cloudinary.uploader.upload_stream, destroy: cloudinary.uploader.destroy,
      download: cloudinary.utils.private_download_url, ai: groq.chat.completions.create };
    const objects = new Set<string>();
    (cloudinary.uploader as any).upload_stream = (options: any, callback: any) => new Writable({
      write(_chunk, _encoding, done) { done(); }, final(done) {
        assert.equal(options.type, 'authenticated'); objects.add(options.public_id);
        callback(null, { public_id: options.public_id, format: 'pdf' }); done();
      },
    });
    (cloudinary.uploader as any).destroy = async (key: string) => { objects.delete(key); return { result: 'ok' }; };
    (cloudinary.utils as any).private_download_url = (key: string) => `https://example.com/private/${key}`;
    (groq.chat.completions as any).create = async () => { throw new Error('AI unavailable'); };
    const app = express();
    app.use(express.json());
    app.post('/upload', protectPostgres, upload.single('resume'), resumes.uploadResume);
    app.get('/', protectPostgres, resumes.getMyResumes);
    app.get('/:id/download', protectPostgres, resumes.downloadResume);
    app.patch('/:id/default', protectPostgres, resumes.setDefaultResume);
    app.delete('/:id', protectPostgres, resumes.deleteResume);
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));
    const server = app.listen(0);
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
      await resolvePostgresUser(token, true);
      return token;
    };
    try {
      const ownerToken = await makeIdentity('owner');
      const otherToken = await makeIdentity('other');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Server did not bind');
      const base = `http://127.0.0.1:${address.port}`;
      const form = new FormData();
      form.append('resume', new Blob([readFileSync(resolve(__dirname, 'fixtures/resume.pdf'))], { type: 'application/pdf' }), 'resume.pdf');
      let response = await fetch(`${base}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` }, body: form });
      assert.equal(response.status, 201);
      const row = (await response.json()).resume;
      assert.equal(row.deliveryType, 'authenticated');
      assert.equal(row.isParsed, false);
      assert.equal(objects.size, 1);
      response = await fetch(`${base}/${row.id}/download`, { headers: { Authorization: `Bearer ${otherToken}` } });
      assert.equal(response.status, 404);
      response = await fetch(`${base}/${row.id}/download`, { headers: { Authorization: `Bearer ${ownerToken}` } });
      assert.equal(response.status, 200);
      assert.match((await response.json()).url, /^https:\/\/example.com\/private\//);
      response = await fetch(`${base}/${row.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${otherToken}` } });
      assert.equal(response.status, 404);
      const ownerBeforeDelete = await db.user.findUniqueOrThrow({ where: { firebaseUid: created[0] } });
      const secondary = await db.resume.create({ data: { userId: ownerBeforeDelete.id,
        storageKey: `secondary-${marker}`, originalName: 'secondary.pdf',
        contentType: 'application/pdf', sizeBytes: 100 } });
      const interview = await db.interview.create({ data: { userId: ownerBeforeDelete.id, resumeId: row.id,
        jobTitle: 'Engineer', jobDescription: 'Build reliable systems', experienceLevel: 'mid', questionCount: 1 } });
      response = await fetch(`${base}/${row.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ownerToken}` } });
      assert.equal(response.status, 409);
      assert.equal(await db.resume.count({ where: { id: row.id } }), 1);
      await db.question.create({ data: { interviewId: interview.id, ordinal: 0, category: 'technical',
        difficulty: 'medium', prompt: 'How would you design this?', expectedKeywords: [], generationVersion: 'test' } });
      await db.interview.update({ where: { id: interview.id }, data: { generationStatus: 'generated', status: 'ready' } });
      response = await fetch(`${base}/${row.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ownerToken}` } });
      assert.equal(response.status, 200);
      assert.equal(objects.size, 0);
      const retained = await db.interview.findUniqueOrThrow({ where: { id: interview.id }, include: { questions: true } });
      assert.equal(retained.resumeId, null);
      assert.deepEqual(retained.resumeSnapshot, { hadResume: true });
      assert.equal(retained.questions.length, 1);
      assert.equal((await db.resume.findUniqueOrThrow({ where: { id: secondary.id } })).isDefault, true);
      const owner = await db.user.findUniqueOrThrow({ where: { firebaseUid: created[0] } });
      const retryKey = `cleanup-${marker}`;
      const retryResume = await db.resume.create({ data: { userId: owner.id, storageKey: retryKey,
        originalName: 'retry.pdf', contentType: 'application/pdf', sizeBytes: 100 } });
      objects.add(retryKey);
      (cloudinary.uploader as any).destroy = async () => { throw new Error('Provider unavailable'); };
      response = await fetch(`${base}/${retryResume.id}`, { method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}` } });
      assert.equal(response.status, 200);
      assert.equal(await db.resume.count({ where: { id: retryResume.id } }), 0);
      const cleanup = await db.backgroundJob.findFirstOrThrow({ where: { resourceId: retryResume.id,
        kind: 'cleanup_cloudinary' } });
      assert.equal(cleanup.state, 'failed');
      assert.ok(cleanup.nextAttemptAt);
      (cloudinary.uploader as any).destroy = async (key: string) => { objects.delete(key); return { result: 'ok' }; };
      await db.backgroundJob.update({ where: { id: cleanup.id }, data: { nextAttemptAt: new Date(0) } });
      assert.equal(await processExternalCleanupJob(cleanup.id), true);
      assert.equal((await db.backgroundJob.findUniqueOrThrow({ where: { id: cleanup.id } })).state, 'succeeded');
      assert.equal(objects.size, 0);
    } finally {
      (cloudinary.uploader as any).upload_stream = originals.upload;
      (cloudinary.uploader as any).destroy = originals.destroy;
      (cloudinary.utils as any).private_download_url = originals.download;
      (groq.chat.completions as any).create = originals.ai;
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      await db.user.deleteMany({ where: { firebaseUid: { in: created } } });
      await Promise.allSettled(created.map(uid => firebase.deleteUser(uid)));
      await db.$disconnect();
    }
  });

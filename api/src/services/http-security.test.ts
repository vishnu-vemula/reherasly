import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

test('public API requests are bounded and unapproved origins receive no CORS access', async () => {
  process.env.REDIS_ENABLED = 'false';
  process.env.RATE_LIMIT_MAX = '2';
  process.env.CLIENT_URL = 'http://localhost:5173';
  process.env.GROQ_API_KEY = 'test-groq-key';
  const { default: app } = await import('../app.js') as any;
  const server = createServer(app);
  await new Promise<void>(done => server.listen(0, done));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind');
    const url = `http://127.0.0.1:${address.port}/api/health`;
    const first = await fetch(url, { headers: { Origin: 'https://unapproved.example' } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('access-control-allow-origin'), null);
    const authenticated = await fetch(url, { headers: { Authorization: 'Bearer test' } });
    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(url)).status, 429);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

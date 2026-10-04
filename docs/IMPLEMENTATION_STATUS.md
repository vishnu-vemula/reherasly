# Implementation status (updated 2026-10-04)

The live Express routes now use Firebase ID tokens, PostgreSQL/Prisma users and application records, and a consolidated PostgreSQL job listing. The frontend uses the Firebase SDK for candidate and admin login and does not persist application JWTs. MongoDB code remains only in migration tools and an isolated legacy regression test app; `api/src/server.ts` does not connect to MongoDB. These changes still require full acceptance and provider checks before production deployment.

## Local evidence

- Prisma schema and seven migrations cover users, resumes, interviews, questions, sessions, answers, subscriptions, PayU orders/events, quota, jobs/sync, plans, templates, prompts, settings, scraper config/logs, transactions, audit data and durable external cleanup jobs. Ownership foreign keys and unique indexes protect joins and idempotency.
- Firebase Auth Emulator + PostgreSQL tests exercise verified UID reconciliation, role and account status changes, owner checks, resume storage mock, candidate interview/session retries, quota concurrency, PayU callback/refund idempotency, account deletion, admin permissions/jobs, and Socket.IO access.
- A disposable migration rehearsal seeded one user and one record of each of 20 related kinds. It mapped all 20, reported zero exceptions/warnings and repeated without duplicate inserts. See [the reconciliation report](MIGRATION_REHEARSAL_REPORT.md). This is a synthetic fixture, not a production data reconciliation.
- Legacy MongoDB/JWT behaviors are retained in `api/src/legacy-test-app.ts` solely for regression tests of the previous implementation. The live server imports the Firebase/PostgreSQL route implementations.
- Seven migrations deployed and Prisma Client generated against a clean disposable PostgreSQL database; `prisma migrate status` reported up to date.
- `npm run typecheck`, `npm run build` and the full sequential `npm test` passed in `api/`: 21 tests, zero failures or skips. The suite includes both live PostgreSQL/Firebase tests and isolated legacy regression tests.
- `npm run lint` and `npm run build` passed in `frontend/`. `npm run test:e2e` passed: four browser tests, zero failures or skips. They cover registration, email verification, reload/session restoration, forced token refresh, password change/reset, sign-out, account retirement, candidate resume/interview/session/jobs/PayU handoff and admin console access against the local API, Auth Emulator and disposable PostgreSQL.
- `npm audit --omit=dev --audit-level=high` reported zero vulnerabilities for both packages. `git diff --check` reported no whitespace errors.

## External verification still required

- A real Firebase staging project and authorized domains to verify imported bcrypt passwords, email action links, Google sign-in, Admin SDK credentials, disabled/revoked users and bootstrap.
- PayU test merchant key/salt plus a public HTTPS callback URL for a real checkout, duplicate/delayed webhook and refund reconciliation.
- Cloudinary credentials for real private PDF upload/download/delete and migration of legacy public objects.
- Groq/OpenAI credentials for generation, evaluation and embedding timeouts and recovery.
- Adzuna app ID/key for a real scheduled job sync, deduplication and stale-listing cleanup check.
- A restored, frozen copy of actual MongoDB and legacy PostgreSQL jobs data to run the import, compare every source/destination count, investigate warnings, and verify representative ownership joins. The local rehearsal cannot establish actual migration completeness.
- Browser journeys against real Firebase/PayU/Cloudinary/AI staging providers, a public staging deployment, and a backup/restore drill. The local browser suite uses the Auth Emulator and mocks external provider boundaries. No production database or provider data has been modified by this work.

## Known risks

- Generation/evaluation and resume parsing still run in request processes. PostgreSQL leases make retries safer, but a durable worker and alerting are needed for process crash recovery.
- Cloudinary and Firebase cleanup are recorded in a PostgreSQL outbox and retried after partial failure. These external operations are not distributed transactions; recurring failures require operator attention.
- Admin mutation audit intents are written before handlers run. An interrupted request can leave a `warning` row for operator review; a strict final outcome guarantee still requires a transactional audit write in each mutating service.
- The legacy regression suite is separate from live-route acceptance; passing it does not establish Firebase/PostgreSQL functionality.
- The frontend development toolchain still reports five high advisories through Tailwind 3's glob dependencies. The current `braces` advisory lists no patched version; a Tailwind 4 migration needs visual regression testing. Production dependency audits report zero vulnerabilities.

## October hardening

- API limits now use a shared Redis store in production; reverse-proxy trust is explicit, browser Socket.IO origins are checked, UUID routes reject malformed IDs, and AI calls have bounded timeouts.
- Generated interviews retain their questions after the source resume is deleted. Pending generation blocks that deletion, and deleting a default resume promotes another resume.
- Payment checkout retries reuse one idempotency key, the result page retries transient status failures, and old pending refunds remain eligible for reconciliation. Refunds accepted without a request ID recover it through PayU transaction history after matching the refund token and amount.
- In-progress question generation and scoring are visible after refresh and can be retried after their leases expire. Scoring attempt timestamps keep an older worker from committing over a newer attempt.
- Admin mutations require a persisted audit intent before handlers run. An interrupted request leaves a warning row for investigation.
- On this workstation, API typecheck/build and frontend lint/build pass. Four API tests pass; 19 integration tests skip because disposable PostgreSQL, MongoDB and the Firebase Auth Emulator are unavailable. CI config provisions these services, but its current run has not been observed here.

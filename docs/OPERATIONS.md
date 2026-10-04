# Local environment and operations

## Fresh local setup

1. Install Node.js 22, Docker with Compose, and the dependencies in both `api` and `frontend` using `npm ci`.
2. Run `docker compose up -d` from the repository root. This starts PostgreSQL 17 and Redis on loopback only. MongoDB is available with `docker compose --profile migration up -d mongo` for a disposable legacy import rehearsal. The Compose password is for local development only.
3. Copy `api/.env.example` to `api/.env` and `frontend/.env.example` to `frontend/.env`. Set `DATABASE_URL=postgresql://interviewmaster:local_development_only@127.0.0.1:5432/interviewmaster` and provide local test or real provider values as appropriate. Never commit either `.env` file.
4. Run `npm run prisma:generate` and `npx prisma migrate deploy` in `api`. Run the Firebase Auth Emulator with `npx firebase-tools@15.31.0 emulators:start --only auth --project demo-interviewmaster` from `api` for local testing.
5. Run `npm run dev` in `api` and `frontend`. Configure matching Firebase demo project IDs and the emulator URL. The API readiness endpoint is `/api/ready`; it checks PostgreSQL, Redis, PayU configuration and Firebase Admin availability.
6. Run `npm run build` in each package. The `Verify` GitHub workflow provisions disposable databases and the Auth Emulator, applies the Prisma migration, runs API integration tests including the related-data import, and runs the browser authentication journey. The workflow has been added but has not yet run on GitHub.

`npm run smoke:providers` in `api` uploads a synthetic PDF through the configured Cloudinary path, downloads and deletes it, requests one embedding, and generates three validated questions. It uses whatever provider base URLs are configured in the environment. Loopback or other custom base URLs may be mocks; this command only verifies real providers when the configuration points to real provider services with real credentials. PayU has its separate sandbox procedure in `docs/PAYU.md`.

The `.env.example` files are the variable reference. Current required API settings are `DATABASE_URL`, `FIREBASE_PROJECT_ID`, `GROQ_API_KEY`, Cloudinary cloud/key/secret, `CLIENT_URL`, `API_PUBLIC_URL`, PayU merchant key/salt/mode. Production startup also requires `OPENAI_API_KEY`, PostgreSQL TLS and Redis. The frontend needs `VITE_API_URL` and Firebase web configuration. `MONGO_URI` and `LEGACY_JOBS_DATABASE_URL` are for migration only.

## Backup and restore before a data migration

Use a maintenance window or a consistent database snapshot. Record backup time, source database names, code revision, Prisma migration version, Firebase project ID, Cloudinary account and PayU merchant account. Keep all exports encrypted and access controlled. A live write stream continuing across independent MongoDB, PostgreSQL, Firebase and object storage backups is **not** a transactionally consistent backup.

Example commands using explicit connection strings supplied through environment variables:

```bash
mongodump --uri "$MONGO_BACKUP_URI" --archive=interviewmaster-mongo.archive --gzip
pg_dump --format=custom --no-owner --file=interviewmaster-postgres.dump "$DATABASE_URL"
```

For a disposable restore drill, create new empty databases, then run:

```bash
mongorestore --uri "$MONGO_RESTORE_URI" --archive=interviewmaster-mongo.archive --gzip --drop
pg_restore --dbname "$RESTORE_DATABASE_URL" --no-owner --clean --if-exists interviewmaster-postgres.dump
```

`--drop` and `--clean` destroy objects in the **restore target**. Verify the target connection strings point to dedicated empty drill databases before running. Never use the production URLs for the restore drill. Cloudinary resume objects and Firebase Auth users require separately managed exports or provider backup arrangements; these two commands do not capture them. Test a private resume download and an imported user's sign-in against the drill/staging environment. Compare counts of users, resumes, interviews, sessions, payment orders and active subscriptions with the source. Run the relationship checks in `docs/POSTGRESQL_SCHEMA.md` and reconcile PayU order totals before considering cutover.

## Deployment and rollback gate

The live application now uses PostgreSQL and Firebase, but local mocks do not satisfy the supplied production acceptance criteria. Before any launch, run the user and related-data migration against a backup copy, verify a real Firebase project bcrypt import and Google sign-in, execute a PayU sandbox payment/refund through public HTTPS callbacks, test Cloudinary cleanup and real AI timeouts, and restore a backup. See `docs/IMPLEMENTATION_STATUS.md` for the remaining work.

Deploy the API and frontend from the same reviewed revision. Apply `prisma migrate deploy` before switching traffic. Configure HTTPS `CLIENT_URL` and `API_PUBLIC_URL` with no path/query, restricted CORS, secrets from a secret manager, real Firebase Admin credentials, PayU merchant configuration, Redis, and logging/alerting. Set `TRUST_PROXY_HOPS` to the exact number of trusted reverse proxy hops (0 for direct access), and ensure the edge proxy replaces untrusted `X-Forwarded-For` values. API and PayU callback rate-limit counters use Redis in production, so Redis loss causes those requests to fail until the store recovers. Probe `/api/ready` before routing traffic. A rollback should first stop new writes and PayU checkout, preserve the current databases and webhook logs, then return to the prior reviewed revision and reconcile any payment notifications received during the change. Do not reverse an applied schema migration without a verified restoration plan.

Watch readiness failures, callback 4xx/5xx rates, pending payment and refund age, stuck `generating`/`evaluating` sessions, Redis connectivity, AI error rates, and failed `BackgroundJob` rows whose kind is `cleanup_cloudinary` or `cleanup_firebase`. The cleanup worker retries with a bounded delay and reclaims stale running leases. Inspect repeated failures and resolve provider configuration or permissions. Generation and evaluation still need a durable worker; automated alert rules are not included.

# 🎯 InterviewMaster

> **Current implementation status:** The API uses PostgreSQL/Prisma for application data and Firebase Authentication for identity. PayU India hosted checkout, reconciliation, private PDF uploads and interview allowances have local integration tests. Real Firebase project migration, PayU sandbox, Cloudinary and AI provider verification remain required before production. See [implementation status](docs/IMPLEMENTATION_STATUS.md), [local setup and operations](docs/OPERATIONS.md), [PayU setup](docs/PAYU.md), [schema](docs/POSTGRESQL_SCHEMA.md) and [user migration](docs/USER_MIGRATION.md).

<div align="center">

![InterviewMaster Banner](https://img.shields.io/badge/Interview-Master-419683?style=for-the-badge&logo=target&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)

**A mock interview platform that reads your resume, asks real questions, and scores every answer.**

[Getting Started](#-getting-started) · [API Reference](#-api-endpoints) · [Architecture](#-project-structure)

</div>

---

## 📖 Overview

**InterviewMaster** runs realistic mock interviews end to end:

1. Upload a **resume (PDF)** — text is extracted and semantically chunked
2. Paste a **job description** and pick topics / difficulty
3. A **RAG pipeline** retrieves the parts of your resume that match the role
4. Questions are generated from *your actual experience* (Groq / Llama 3)
5. Follow-ups stream in **real time** over Socket.io, reacting to each answer
6. Every answer is scored, and a **full feedback report** closes the session
7. A built-in **Job Board** surfaces matching openings (Adzuna API)

---

## ✨ Features

| Feature | Description |
|---|---|
| 📄 Resume ingestion | PDF upload → text extraction → semantic chunking |
| 🧠 RAG pipeline | LangChain + OpenAI embeddings → grounded question generation |
| 💬 Live sessions | Real-time follow-up questions via Socket.io streaming |
| 📊 Answer scoring | Per-answer evaluation + final report via Groq LLM |
| 📈 Dashboard | Session history, score trends, performance analytics |
| 💼 Job Board | Live listings from the Adzuna API with match scoring |
| 🔐 Auth | Firebase Auth with server-side PostgreSQL role and status checks |
| ☁️ Cloud storage | Resumes stored on Cloudinary |
| ⚡ Redis cache | Multi-level caching for job searches |
| 📝 Admin panel | Users, content, prompts, scraper and analytics management |
| 🚦 Request logging | Winston-backed structured logs on every request |

---

## 🛠️ Tech Stack

### API (`/api`)
- **Language**: TypeScript (strict mode, staged ramp-up)
- **Runtime**: Node.js + Express
- **Database**: PostgreSQL (Prisma)
- **AI / LLM**: Groq SDK (Llama 3), LangChain, OpenAI embeddings
- **Real-time**: Socket.io
- **File storage**: Cloudinary + Multer
- **Cache**: Redis (official client, compat wrapper)
- **Auth**: Firebase client and Admin SDK, RBAC middleware
- **Security**: Helmet, CORS, express-rate-limit, compression
- **Logging**: Winston request logging with query strings omitted

### Web (`/frontend`)
- **Framework**: React 18 + Vite
- **State**: Zustand + TanStack React Query
- **Routing**: React Router v7
- **UI / animation**: Framer Motion, Lucide React
- **Styling**: Tailwind CSS (single-accent teal design system)
- **Forms**: React Hook Form
- **Charts**: Recharts
- **Real-time**: Socket.io client

---

## 📁 Project Structure

```
interview-master/
├── api/                            # TypeScript backend
│   └── src/
│       ├── server.ts               # HTTP bootstrap, schedulers, lifecycle
│       ├── app.ts                  # Express app: middleware, routes, logging
│       ├── postgres-socket.ts      # Firebase-authenticated follow-up Q&A
│       ├── config/                 # prisma, redis, groq, cloudinary, logger
│       ├── controllers/            # Route handlers (one concern per module)
│       │   ├── admin.controller/   # stats | users | content + barrel
│       │   ├── auth.controller.ts
│       │   ├── resume.controller.ts
│       │   ├── interview.controller.ts
│       │   ├── session.controller.ts
│       │   ├── jobs.controller.ts
│       │   └── user.controller.ts
│       ├── services/               # Business logic & AI integrations
│       │   ├── ai.service/         # prompts | questions | evaluation | parsing
│       │   ├── adzuna.service.ts   # Job search client (canonical)
│       │   ├── rag.service.ts      # Embeddings + vector retrieval
│       │   ├── chunking.service.ts # Semantic document splitting
│       │   ├── optimizer.service.ts
│       │   └── job-*.ts            # sync, cleanup, search, match services
│       ├── models/                 # Legacy MongoDB import and regression test schemas
│       ├── routes/                 # API route definitions
│       ├── middleware/             # auth, rbac, upload, validation, logging
│       ├── utils/                  # query-parser/, deduplicator, scoring-engine
│       └── types/                  # Express request/response augmentations
│
└── frontend/
    └── src/
        ├── app.jsx                 # Route tree + providers
        ├── main.jsx                # Entry point
        ├── pages/                  # landing, dashboard, interview, jobs, admin
        ├── components/             # navigation/, admin/, jobs/, ui/
        ├── context/                # auth, app, admin-auth contexts
        ├── hooks/                  # use-jobs, use-auth, use-admin-query
        ├── services/               # Axios API clients
        ├── store/                  # Zustand stores (auth-store)
        └── utils/                  # Helpers
```

**Naming conventions**: kebab-case filenames throughout (`user.model.ts`, `admin-sidebar.jsx`); camelCase variables and functions; PascalCase React component identifiers; UPPER_SNAKE_CASE for environment-derived constants.

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v22+
- PostgreSQL 17 and a Firebase project (or the Auth Emulator for local tests)
- [Redis](https://redis.io/) (local or cloud — Upstash / Redis Cloud)
- [Groq API key](https://console.groq.com) — free tier available
- [OpenAI API key](https://platform.openai.com) — for embeddings
- [Cloudinary account](https://cloudinary.com) — for file storage
- [Adzuna API](https://developer.adzuna.com/) — for the Job Board (optional)

### 1. Clone and install

```bash
git clone https://github.com/vishnu-vemula/interview-master.git
cd interview-master
npm run install:all        # installs api/ and frontend/ dependencies
```

### 2. Configure the API

```bash
cd api
cp .env.example .env
```

Fill in `api/.env`:

```env
PORT=5000
NODE_ENV=development

DATABASE_URL=postgresql://interviewmaster:local_development_only@127.0.0.1:5432/interviewmaster
FIREBASE_PROJECT_ID=taskmanager-a5ac2

GROQ_API_KEY=your_groq_api_key
OPENAI_API_KEY=your_openai_api_key

CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

CLIENT_URL=http://localhost:5173
API_PUBLIC_URL=http://localhost:5000
PAYU_ENV=test
PAYU_MERCHANT_KEY=replace_with_test_merchant_key
PAYU_MERCHANT_SALT=replace_with_test_merchant_salt

REDIS_ENABLED=true
REDIS_URL=redis://127.0.0.1:6379

ADZUNA_APP_ID=your_app_id
ADZUNA_APP_KEY=your_app_key
ADZUNA_COUNTRY=in
```

For the live Firebase project, provide API-side Application Default Credentials
for `taskmanager-a5ac2` before starting the API. The web configuration below
does not authenticate the server.

### 3. Configure the frontend

```bash
cd ../frontend
cp .env.example .env
```

`frontend/.env`:

```env
VITE_API_URL=http://localhost:5000/api
VITE_APP_NAME=Rehearsly
VITE_FIREBASE_API_KEY=AIzaSyBIrVkK0IbCkZkybxoiLsd98z_jijzQ1qM
VITE_FIREBASE_AUTH_DOMAIN=taskmanager-a5ac2.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=taskmanager-a5ac2
VITE_FIREBASE_STORAGE_BUCKET=taskmanager-a5ac2.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=467683095414
VITE_FIREBASE_APP_ID=1:467683095414:web:dfc51f26547d2874674057
```

### 4. Apply the database schema and bootstrap the first admin

```bash
cd ../api
npx prisma migrate deploy
npm run prisma:generate
# First create and verify a Firebase user, then set the exact UID and email.
# ADMIN_BOOTSTRAP_FIREBASE_UID=... ADMIN_BOOTSTRAP_EMAIL=...
npm run seed:admin
```

The bootstrap refuses to promote an existing user or run after any staff account exists. Remove its environment variables after use. See [migration instructions](docs/USER_MIGRATION.md).

### 5. Run

```bash
# From the repository root:
npm run dev              # Home page → http://localhost:5173

# In a second terminal, start the API for sign-in and application data:
npm run dev:api          # API → http://localhost:5000
```

If port 5173 is busy, Vite prints the next available URL. The public home page
can open without Firebase settings; sign-in requires the Firebase web values in
`frontend/.env` and a running API. For Vercel, set those same `VITE_FIREBASE_*`
values and `VITE_API_URL` in the frontend project's environment before building.
`VITE_API_URL` must point to a deployed API; `localhost` only works on your computer.

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/firebase/session` | Reconcile a verified Firebase identity with a PostgreSQL User |
| `GET` | `/api/auth/me` | Current PostgreSQL profile from a verified Firebase ID token |
| `POST` | `/api/resumes/upload` | Upload a resume PDF |
| `GET`  | `/api/resumes` | List uploaded resumes |
| `POST` | `/api/interviews` | Create an interview |
| `GET`  | `/api/interviews/:id` | Interview details |
| `POST` | `/api/sessions/start` | Start an interview session |
| `POST` | `/api/sessions/:id/answer` | Submit an answer for evaluation |
| `GET`  | `/api/sessions/:id` | Session and feedback report |
| `GET`  | `/api/users/dashboard` | Dashboard statistics |
| `GET`  | `/api/jobs` | Search the Job Board |
| `GET`  | `/api/health` | Liveness probe |

All requests are logged (method, path, status, duration, IP, user id) via Winston.

---

## 🧠 How a Session Works

```
Resume PDF upload
        ↓
Text extraction (pdf-parse)
        ↓
Semantic chunking (LangChain text splitters)
        ↓
Embeddings (OpenAI) → vector store
        ↓
Create interview (role + topics + difficulty)
        ↓
Query optimization (optimizer.service.ts)
        ↓
RAG retrieval — relevant resume chunks
        ↓
Question generation (Groq / Llama 3)
        ↓
Live interview over Socket.io
        ↓
Answer evaluation (Groq / Llama 3)
        ↓
Final report
```

---

## 📜 Scripts

| Location | Command | What it does |
|---|---|---|
| root | `npm run install:all` | Install API + web dependencies |
| root | `npm run dev:api` / `dev:web` | Run API / frontend in dev mode |
| root | `npm run build` | Build both packages |
| api | `npm run dev` | `tsx watch` — hot-reload dev server |
| api | `npm run build` | Compile TypeScript → `dist/` |
| api | `npm start` | Run the compiled build |
| api | `npm run typecheck` | `tsc --noEmit` type check |
| api | `npm run seed:admin` | One-time verified Firebase super admin bootstrap |
| web | `npm run dev` / `build` / `lint` | Vite dev server / production build / ESLint |

---

## 🤝 Contributing

1. Fork the repository
2. Branch: `git checkout -b feature/my-feature`
3. Commit: `git commit -m "Add my feature"`
4. Push and open a pull request

Please follow the existing conventions: kebab-case filenames, camelCase identifiers, one responsibility per module, and `npm run typecheck` green before submitting.

---

## 📄 License

Released under the [MIT License](LICENSE).

> **Note:** This project is a derivative of the open-source "AI-Interviewer"
> project (portions © Aftab Alam, MIT). The original MIT copyright notice is
> retained in the LICENSE file as required by the license.

---

## 👨‍💻 Author

**vishnu-vemula**

---

<div align="center">

Built with **Groq**, **React**, and **PostgreSQL**

⭐ If InterviewMaster helped you land the job, leave a star!

</div>

# Sentinel DD — Backend (Cloudflare) setup

This documents the multi-user backend being built on **Cloudflare Workers + D1 + R2**.
It is a work in progress; this file tracks what's done and how to run it.

## Status

| Area | State |
|------|-------|
| D1 schema (`schema.sql`) | ✅ users, sessions, projects, documents, outcomes, llm_usage |
| Worker + routing (`worker/index.js`) | ✅ scaffold + static-asset passthrough |
| Auth API | ✅ signup / login / logout / me / Google (verified server-side) |
| Projects API | ✅ list / get / create / save / delete (owner-enforced) |
| Learning-bank API (cross-tenant) | ✅ record / mine / delete / stats / similar (anonymized) |
| Document storage (R2) | ✅ upload / list / download / delete (owner-enforced) |
| Server-side LLM proxy | ✅ /api/llm (key = server secret, per-user daily limit) |
| Frontend migration off IndexedDB | ⏳ not yet |

Until the frontend migration lands, the app still runs fully client-side against
IndexedDB. The Worker can be developed and tested independently in the meantime.

## One-time setup

Requires a (free) Cloudflare account. `npx` will fetch wrangler on first use.

```bash
# 1. Log in
npx wrangler login

# 2. Create the database, then paste the printed database_id into wrangler.jsonc
npx wrangler d1 create sentinel-dd

# 3. Create the document bucket (R2)
npx wrangler r2 bucket create sentinel-dd-docs

# 4. Apply the schema (local dev DB, then remote)
npx wrangler d1 execute sentinel-dd --local  --file=./schema.sql
npx wrangler d1 execute sentinel-dd --remote --file=./schema.sql

# 5. LLM keys become server secrets (never shipped to the browser) — used by a later phase
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY
```

## Before first deploy: move the frontend into `public/`

The Worker source lives in `worker/`. `wrangler.jsonc` serves static assets from
`./public`, so the app's static files must move there so `worker/` and `schema.sql`
are never publicly downloadable:

```bash
mkdir public
git mv index.html app.js config.js styles.css logo.svg favicon.png public/
git mv js public/js
```

`server.rb` (local static dev) should then point its DocumentRoot at `public/`.
The GitHub Pages workflow (`.github/workflows/static.yml`) can be removed once
Cloudflare is the canonical deploy — Pages can't run the Worker backend.

## Run locally

```bash
npx wrangler dev
# Worker + assets on http://localhost:8787  (API under /api/*)
```

## Deploy

```bash
npx wrangler deploy
```

## API (implemented so far)

| Method | Path | Body | Notes |
|--------|------|------|-------|
| GET  | `/api/health` | — | liveness |
| POST | `/api/auth/signup` | `{email,password,name}` | sets session cookie |
| POST | `/api/auth/login`  | `{email,password}` | sets session cookie |
| POST | `/api/auth/google` | `{credential}` | Google ID token, **verified server-side** |
| POST | `/api/auth/logout` | — | clears session |
| GET  | `/api/auth/me`     | — | current user or `{user:null}` |
| GET  | `/api/projects` | — | list caller's projects |
| POST | `/api/projects` | `{project}` | create |
| GET/PUT/DELETE | `/api/projects/:id` | `{project}` | get / save / delete (owner-only) |
| GET/POST | `/api/projects/:id/documents` | multipart | list / upload (file → R2, text → `.txt` sibling) |
| GET  | `/api/documents/:id/content` | — | stream file bytes (owner-only) |
| DELETE | `/api/documents/:id` | — | delete file + metadata |
| POST | `/api/outcomes` | `{industry,dealType,analysis,outcome,consent}` | contribute (consent required) |
| GET  | `/api/outcomes/mine` | — | caller's own contributions (full detail) |
| DELETE | `/api/outcomes/:id` | — | delete own contribution |
| POST | `/api/outcomes/similar` | `{industry,dealType,value,riskCounts}` | comparable deals, **anonymized cross-tenant** |
| GET  | `/api/outcomes/stats` | — | learning-bank aggregates |
| POST | `/api/llm` | `{system,user,provider?,model?}` | model proxy; key is a server secret; metered per user/day |

All non-auth routes require a valid session. Verified end-to-end against a local
D1+R2 via `wrangler dev` — including 401/404/409 paths and a planted-secret test
proving `/api/outcomes/similar` never leaks owner, source project, or notes.

**Security model:** passwords use PBKDF2-SHA256 (100k iterations) + per-user salt.
Sessions are random 256-bit tokens delivered as an `HttpOnly; Secure; SameSite=Lax`
cookie; only the SHA-256 of the token is stored, so a DB leak can't be replayed.
Google ID tokens are verified against Google (signature/expiry) with an audience
check — replacing the prototype's unverified client-side decode.

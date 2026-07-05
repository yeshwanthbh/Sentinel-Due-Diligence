-- Sentinel DD — Cloudflare D1 (SQLite) schema
-- Apply locally:   npx wrangler d1 execute sentinel-dd --local  --file=./schema.sql
-- Apply to cloud:  npx wrangler d1 execute sentinel-dd --remote --file=./schema.sql
--
-- Design notes:
--  * Project analysis state (findings, evidence, research, memo, risks…) is kept
--    as a JSON blob in projects.data — this mirrors the current IndexedDB model so
--    the frontend can migrate with minimal churn. Hot query columns are promoted
--    to real columns + indexes. Normalize later if a workstream needs SQL queries.
--  * Raw document bytes live in R2 (see worker), NOT in D1. documents holds metadata
--    + the R2 object key only.
--  * outcomes is the shared, cross-tenant learning bank. It stores ONLY anonymized,
--    structured data (no company name, no documents). owner_id exists solely so a
--    contributor can delete their own submission; it is never returned to other users.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT,                       -- NULL for pure Google accounts
  salt          TEXT,
  provider      TEXT NOT NULL DEFAULT 'password',  -- 'password' | 'google'
  google_id     TEXT,
  picture       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ------------------------------------------------------------- sessions
-- Opaque session tokens (stored hashed). Rows are pruned when expired.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,             -- SHA-256 of the bearer token
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ------------------------------------------------------------- projects
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  industry   TEXT,
  type       TEXT,
  deal_type  TEXT,
  status     TEXT,
  progress   INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL DEFAULT '{}',   -- full project state as JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at);

-- ------------------------------------------------------------ documents
-- Metadata for uploaded files; bytes + extracted text live in R2.
CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  category     TEXT,
  doc_type     TEXT,
  r2_key       TEXT NOT NULL,              -- object key in the DOCS bucket
  size         INTEGER,
  content_hash TEXT,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id)   REFERENCES users(id)    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);

-- ------------------------------------------------------------- outcomes
-- Anonymized post-deal learning bank (shared across all tenants).
CREATE TABLE IF NOT EXISTS outcomes (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT,                  -- for "delete my own" only; never exposed cross-tenant
  source_project_id TEXT,
  industry          TEXT,
  deal_type         TEXT,
  value_band        TEXT,
  analysis          TEXT NOT NULL DEFAULT '{}',  -- pre-close snapshot (JSON)
  outcome           TEXT NOT NULL DEFAULT '{}',  -- user-submitted result (JSON)
  consent           INTEGER NOT NULL DEFAULT 0,  -- must be 1 to be used
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outcomes_consent ON outcomes(consent);
CREATE INDEX IF NOT EXISTS idx_outcomes_match ON outcomes(deal_type, industry);
CREATE INDEX IF NOT EXISTS idx_outcomes_owner ON outcomes(owner_id);

-- --------------------------------------------------- llm usage metering
-- Per-user LLM call accounting so the server-side proxy can rate-limit.
CREATE TABLE IF NOT EXISTS llm_usage (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  day        TEXT NOT NULL,                -- YYYY-MM-DD
  calls      INTEGER NOT NULL DEFAULT 0,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, day)
);

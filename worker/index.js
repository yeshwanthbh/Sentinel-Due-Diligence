/* Sentinel DD — Cloudflare Worker API
 * ------------------------------------------------------------------
 * Backend for the multi-user product. Serves the static frontend (via the
 * ASSETS binding) and exposes a JSON API under /api/*.
 *
 * This file currently implements the AUTH foundation:
 *   POST /api/auth/signup   { email, password, name }
 *   POST /api/auth/login    { email, password }
 *   POST /api/auth/google   { credential }   (Google ID token, verified server-side)
 *   POST /api/auth/logout
 *   GET  /api/auth/me
 *   GET  /api/health
 *
 * Sessions are opaque random tokens delivered as an HttpOnly, Secure, SameSite
 * cookie. We store only the SHA-256 of the token in D1, so a DB leak can't be
 * replayed. Passwords use PBKDF2-SHA256 (100k iterations) with a per-user salt.
 *
 * Bindings (see wrangler.jsonc):
 *   env.DB               D1 database
 *   env.DOCS             R2 bucket (documents — used by later phases)
 *   env.ASSETS           static asset server (the frontend)
 *   env.GOOGLE_CLIENT_ID var — used to validate the `aud` of Google ID tokens
 */

const SESSION_TTL_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000;
const enc = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API routes live under /api/*; everything else is a static asset.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    }

    // CORS preflight (same-origin in prod, but permit credentialed dev origins).
    if (request.method === "OPTIONS") return cors(request, new Response(null, { status: 204 }));

    try {
      const res = await route(request, env, ctx, url);
      return cors(request, res);
    } catch (err) {
      console.error(err);
      return cors(request, json({ error: err.message || "Internal error" }, err.status || 500));
    }
  }
};

/* --------------------------------------------------------------- router */
async function route(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health") return json({ ok: true, time: new Date().toISOString() });

  if (path === "/api/auth/signup" && method === "POST") return signup(request, env);
  if (path === "/api/auth/login" && method === "POST") return login(request, env);
  if (path === "/api/auth/google" && method === "POST") return googleAuth(request, env);
  if (path === "/api/auth/logout" && method === "POST") return logout(request, env);
  if (path === "/api/auth/me" && method === "GET") return me(request, env);

  // ---- projects (auth required) ----
  if (path === "/api/projects" && method === "GET") return listProjects(request, env);
  if (path === "/api/projects" && method === "POST") return createProject(request, env);
  const projMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (projMatch) {
    const id = decodeURIComponent(projMatch[1]);
    if (method === "GET") return getProject(request, env, id);
    if (method === "PUT") return saveProject(request, env, id);
    if (method === "DELETE") return deleteProject(request, env, id);
  }

  // ---- documents (R2-backed, auth required) ----
  const docsListMatch = /^\/api\/projects\/([^/]+)\/documents$/.exec(path);
  if (docsListMatch) {
    const pid = decodeURIComponent(docsListMatch[1]);
    if (method === "GET") return listDocuments(request, env, pid);
    if (method === "POST") return uploadDocument(request, env, pid);
  }
  const docContentMatch = /^\/api\/documents\/([^/]+)\/content$/.exec(path);
  if (docContentMatch && method === "GET") return getDocumentContent(request, env, decodeURIComponent(docContentMatch[1]));
  const docMatch = /^\/api\/documents\/([^/]+)$/.exec(path);
  if (docMatch && method === "DELETE") return deleteDocument(request, env, decodeURIComponent(docMatch[1]));

  // ---- learning bank / outcomes (auth required) ----
  if (path === "/api/outcomes" && method === "POST") return recordOutcome(request, env);
  if (path === "/api/outcomes/mine" && method === "GET") return myOutcomes(request, env);
  if (path === "/api/outcomes/similar" && method === "POST") return similarOutcomes(request, env);
  if (path === "/api/outcomes/stats" && method === "GET") return outcomeStats(request, env);
  const outMatch = /^\/api\/outcomes\/([^/]+)$/.exec(path);
  if (outMatch && method === "DELETE") return deleteOutcome(request, env, decodeURIComponent(outMatch[1]));

  // ---- LLM proxy (auth required; keys are server secrets) ----
  if (path === "/api/llm" && method === "POST") return llmProxy(request, env);
  if (path === "/api/llm/status" && method === "GET") return llmStatus(request, env);

  return json({ error: "Not found" }, 404);
}

// Resolve the authenticated user or throw a 401 the top-level handler turns into JSON.
async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) { const e = new Error("Not authenticated."); e.status = 401; throw e; }
  return user;
}

/* ----------------------------------------------------------- auth: core */
async function signup(request, env) {
  const { email, password, name } = await readJson(request);
  const normEmail = normalizeEmail(email);
  if (!normEmail || !password || password.length < 6) {
    return json({ error: "Email and a password of at least 6 characters are required." }, 400);
  }
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(normEmail).first();
  if (existing) return json({ error: "An account with that email already exists." }, 409);

  const salt = randomHex(16);
  const passwordHash = await hashPassword(password, salt);
  const user = {
    id: uuid(),
    email: normEmail,
    name: (name || "").trim() || normEmail.split("@")[0],
    provider: "password",
    created_at: new Date().toISOString()
  };
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, password_hash, salt, provider, created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(user.id, user.email, user.name, passwordHash, salt, "password", user.created_at).run();

  return withSession(env, user, json({ user: publicUser(user) }));
}

async function login(request, env) {
  const { email, password } = await readJson(request);
  const normEmail = normalizeEmail(email);
  const row = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(normEmail).first();
  if (!row) return json({ error: "No account found for that email." }, 401);
  if (!row.password_hash && row.provider === "google") {
    return json({ error: "This account uses Google sign-in. Use “Continue with Google”." }, 400);
  }
  const attempt = await hashPassword(password || "", row.salt);
  if (!timingSafeEqual(attempt, row.password_hash)) return json({ error: "Incorrect password." }, 401);

  return withSession(env, row, json({ user: publicUser(row) }));
}

async function logout(request, env) {
  const token = tokenFromRequest(request);
  if (token) {
    const id = await sha256Hex(token);
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  }
  const res = json({ ok: true });
  res.headers.append("Set-Cookie", clearCookie());
  return res;
}

async function me(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ user: null }, 200);
  return json({ user: publicUser(user) });
}

/* ------------------------------------------------- auth: Google sign-in */
// Verify the Google ID token SERVER-SIDE (fixes the client-side unverified
// decode in the prototype). We validate signature/expiry via Google's tokeninfo
// endpoint and check the audience matches our OAuth client.
async function googleAuth(request, env) {
  const { credential } = await readJson(request);
  if (!credential) return json({ error: "Missing Google credential." }, 400);

  const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  if (!resp.ok) return json({ error: "Google token verification failed." }, 401);
  const claims = await resp.json();

  if (env.GOOGLE_CLIENT_ID && claims.aud !== env.GOOGLE_CLIENT_ID) {
    return json({ error: "Google token audience mismatch." }, 401);
  }
  if (claims.email_verified === "false" || !claims.email) {
    return json({ error: "Google account email is not verified." }, 401);
  }

  const normEmail = normalizeEmail(claims.email);
  let row = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(normEmail).first();
  if (row) {
    await env.DB.prepare(
      "UPDATE users SET provider='google', google_id=?, picture=COALESCE(?, picture), name=COALESCE(NULLIF(name,''), ?) WHERE id=?"
    ).bind(claims.sub || row.google_id || null, claims.picture || null, claims.name || null, row.id).run();
  } else {
    row = {
      id: uuid(),
      email: normEmail,
      name: (claims.name || normEmail.split("@")[0]).trim(),
      provider: "google",
      google_id: claims.sub || null,
      picture: claims.picture || null,
      created_at: new Date().toISOString()
    };
    await env.DB.prepare(
      "INSERT INTO users (id, email, name, provider, google_id, picture, created_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(row.id, row.email, row.name, "google", row.google_id, row.picture, row.created_at).run();
  }
  return withSession(env, row, json({ user: publicUser(row) }));
}

/* ------------------------------------------------------------ projects */
// Projects persist their full analysis state as a JSON blob (projects.data),
// mirroring the client model. Ownership is enforced on every read and write.
async function listProjects(request, env) {
  const user = await requireUser(request, env);
  const { results } = await env.DB.prepare(
    "SELECT data FROM projects WHERE owner_id = ? ORDER BY updated_at DESC"
  ).bind(user.id).all();
  return json({ projects: (results || []).map((r) => safeParse(r.data)) });
}

async function getProject(request, env, id) {
  const user = await requireUser(request, env);
  const row = await env.DB.prepare("SELECT data FROM projects WHERE id = ? AND owner_id = ?").bind(id, user.id).first();
  if (!row) return json({ error: "Project not found." }, 404);
  return json({ project: safeParse(row.data) });
}

async function createProject(request, env) {
  const user = await requireUser(request, env);
  const project = await readJson(request);
  if (!project || !project.name) return json({ error: "A project name is required." }, 400);
  const now = new Date().toISOString();
  project.id = project.id || uuid();
  project.ownerId = user.id;
  project.createdAt = project.createdAt || now;
  project.updatedAt = now;
  await persistProject(env, user.id, project);
  return json({ project }, 201);
}

async function saveProject(request, env, id) {
  const user = await requireUser(request, env);
  const owned = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND owner_id = ?").bind(id, user.id).first();
  if (!owned) return json({ error: "Project not found." }, 404);
  const project = await readJson(request);
  project.id = id;
  project.ownerId = user.id;
  project.updatedAt = new Date().toISOString();
  await persistProject(env, user.id, project);
  return json({ project });
}

async function deleteProject(request, env, id) {
  const user = await requireUser(request, env);
  // Remove any R2 document objects for this project before dropping the rows.
  const { results } = await env.DB.prepare(
    "SELECT r2_key FROM documents WHERE project_id = ? AND owner_id = ?"
  ).bind(id, user.id).all();
  if (env.DOCS && results) {
    await Promise.all(results.map((d) => env.DOCS.delete(d.r2_key).catch(() => {})));
  }
  const res = await env.DB.prepare("DELETE FROM projects WHERE id = ? AND owner_id = ?").bind(id, user.id).run();
  if (!res.meta.changes) return json({ error: "Project not found." }, 404);
  return json({ ok: true });
}

async function persistProject(env, ownerId, project) {
  await env.DB.prepare(
    `INSERT INTO projects (id, owner_id, name, industry, type, deal_type, status, progress, data, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, industry=excluded.industry, type=excluded.type, deal_type=excluded.deal_type,
       status=excluded.status, progress=excluded.progress, data=excluded.data, updated_at=excluded.updated_at`
  ).bind(
    project.id, ownerId, project.name, project.industry || null, project.type || null,
    project.dealType || null, project.status || null, project.progress || 0,
    JSON.stringify(project), project.createdAt, project.updatedAt
  ).run();
}

/* ----------------------------------------------- documents (R2-backed) */
// Raw file bytes — the confidential material — live in R2, never in D1 or the
// browser's reach beyond the owner. The documents table holds metadata + the R2
// key. Extracted text is stored as a sibling ".txt" object so the server-side
// LLM proxy can analyze documents without re-parsing binaries.
async function assertProjectOwner(env, user, projectId) {
  const row = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND owner_id = ?").bind(projectId, user.id).first();
  if (!row) { const e = new Error("Project not found."); e.status = 404; throw e; }
}

async function uploadDocument(request, env, projectId) {
  const user = await requireUser(request, env);
  await assertProjectOwner(env, user, projectId);
  if (!env.DOCS) return json({ error: "Document storage is not configured." }, 503);

  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "A file is required." }, 400);

  const docId = uuid();
  const key = `${user.id}/${projectId}/${docId}`;
  await env.DOCS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" }
  });
  const text = form.get("text");
  if (typeof text === "string" && text) await env.DOCS.put(`${key}.txt`, text);

  const doc = {
    id: docId,
    project_id: projectId,
    owner_id: user.id,
    name: (form.get("name") || file.name || "document").toString(),
    category: (form.get("category") || "Uncategorized").toString(),
    doc_type: (form.get("docType") || "").toString(),
    r2_key: key,
    size: file.size || null,
    content_hash: (form.get("contentHash") || "").toString() || null,
    created_at: new Date().toISOString()
  };
  await env.DB.prepare(
    `INSERT INTO documents (id, project_id, owner_id, name, category, doc_type, r2_key, size, content_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(doc.id, doc.project_id, doc.owner_id, doc.name, doc.category, doc.doc_type, doc.r2_key, doc.size, doc.content_hash, doc.created_at).run();

  return json({ document: docToJson(doc) }, 201);
}

async function listDocuments(request, env, projectId) {
  const user = await requireUser(request, env);
  await assertProjectOwner(env, user, projectId);
  const { results } = await env.DB.prepare(
    "SELECT * FROM documents WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC"
  ).bind(projectId, user.id).all();
  return json({ documents: (results || []).map(docToJson) });
}

async function getDocumentContent(request, env, id) {
  const user = await requireUser(request, env);
  const doc = await env.DB.prepare("SELECT * FROM documents WHERE id = ? AND owner_id = ?").bind(id, user.id).first();
  if (!doc) return json({ error: "Document not found." }, 404);
  if (!env.DOCS) return json({ error: "Document storage is not configured." }, 503);
  const object = await env.DOCS.get(doc.r2_key);
  if (!object) return json({ error: "File missing from storage." }, 404);
  const headers = new Headers();
  headers.set("content-type", object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("content-disposition", `attachment; filename="${doc.name.replace(/"/g, "")}"`);
  return new Response(object.body, { headers });
}

async function deleteDocument(request, env, id) {
  const user = await requireUser(request, env);
  const doc = await env.DB.prepare("SELECT * FROM documents WHERE id = ? AND owner_id = ?").bind(id, user.id).first();
  if (!doc) return json({ error: "Document not found." }, 404);
  if (env.DOCS) {
    await env.DOCS.delete(doc.r2_key).catch(() => {});
    await env.DOCS.delete(`${doc.r2_key}.txt`).catch(() => {});
  }
  await env.DB.prepare("DELETE FROM documents WHERE id = ? AND owner_id = ?").bind(id, user.id).run();
  return json({ ok: true });
}

function docToJson(d) {
  return {
    id: d.id, projectId: d.project_id, name: d.name, category: d.category,
    docType: d.doc_type, size: d.size, contentHash: d.content_hash, createdAt: d.created_at
  };
}

/* ------------------------------------------- learning bank (outcomes) */
// The learning bank is shared across all tenants but stores ONLY anonymized,
// structured data. owner_id exists solely so a contributor can delete their own
// submission — it is never returned to other users, and free-text notes are
// withheld from cross-tenant responses.
async function recordOutcome(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  if (body.consent !== true) return json({ error: "Consent is required to contribute an outcome." }, 400);
  const outcome = body.outcome || {};
  const rec = {
    id: uuid(),
    owner_id: user.id,
    source_project_id: body.sourceProjectId || null,
    industry: (body.industry || "Unknown").toString(),
    deal_type: (body.dealType || "VC").toString(),
    value_band: body.valueBand || bandFor(outcome.finalPrice || body.value),
    analysis: JSON.stringify(body.analysis || {}),
    outcome: JSON.stringify({
      closed: Boolean(outcome.closed),
      finalPrice: outcome.finalPrice || null,
      materializedRisks: cleanList(outcome.materializedRisks),
      missedRisks: cleanList(outcome.missedRisks),
      successRating: clampRating(outcome.successRating),
      notes: (outcome.notes || "").toString().slice(0, 600) || null
    }),
    consent: 1,
    created_at: new Date().toISOString()
  };
  await env.DB.prepare(
    `INSERT INTO outcomes (id, owner_id, source_project_id, industry, deal_type, value_band, analysis, outcome, consent, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(rec.id, rec.owner_id, rec.source_project_id, rec.industry, rec.deal_type, rec.value_band,
    rec.analysis, rec.outcome, rec.consent, rec.created_at).run();
  return json({ id: rec.id }, 201);
}

// The caller's OWN contributions — full detail, including notes.
async function myOutcomes(request, env) {
  const user = await requireUser(request, env);
  const { results } = await env.DB.prepare(
    "SELECT * FROM outcomes WHERE owner_id = ? ORDER BY created_at DESC"
  ).bind(user.id).all();
  return json({ outcomes: (results || []).map(rowToOutcome) });
}

async function deleteOutcome(request, env, id) {
  const user = await requireUser(request, env);
  const res = await env.DB.prepare("DELETE FROM outcomes WHERE id = ? AND owner_id = ?").bind(id, user.id).run();
  if (!res.meta.changes) return json({ error: "Outcome not found." }, 404);
  return json({ ok: true });
}

// Cross-tenant comparable deals for a project descriptor. Scoring happens here,
// server-side, so a client never receives the full outcome table — only the
// top matches, anonymized (no owner, no source project, no free-text notes).
async function similarOutcomes(request, env) {
  await requireUser(request, env);
  const descriptor = await readJson(request);
  const { results } = await env.DB.prepare("SELECT * FROM outcomes WHERE consent = 1").all();
  const scored = (results || [])
    .map((row) => ({ rec: rowToOutcome(row), score: scoreAgainst(descriptor, row) }))
    .filter((x) => x.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const comparableDeals = scored.map(({ rec, score }) => ({
    similarity: Math.round(score * 100),
    industry: rec.industry,
    dealType: rec.dealType,
    valueBand: rec.valueBand,
    priorRecommendation: rec.analysis?.recommendation?.decision || null,
    priorRiskCounts: rec.analysis?.riskCounts || null,
    outcome: {
      closed: rec.outcome.closed,
      finalPrice: rec.outcome.finalPrice,
      successRating: rec.outcome.successRating,
      materializedRisks: rec.outcome.materializedRisks,
      missedRisks: rec.outcome.missedRisks
      // notes intentionally omitted from cross-tenant responses
    }
  }));
  return json({ comparableDeals, signal: summarize(comparableDeals) });
}

async function outcomeStats(request, env) {
  await requireUser(request, env);
  const { results } = await env.DB.prepare("SELECT deal_type, outcome FROM outcomes WHERE consent = 1").all();
  const rows = results || [];
  const byType = {};
  let ratedSum = 0, rated = 0, closed = 0;
  rows.forEach((r) => {
    byType[r.deal_type] = (byType[r.deal_type] || 0) + 1;
    const o = safeParse(r.outcome);
    if (o.successRating != null) { ratedSum += o.successRating; rated += 1; }
    if (o.closed) closed += 1;
  });
  return json({
    total: rows.length,
    byType,
    avgSuccess: rated ? ratedSum / rated : null,
    closedRate: rows.length ? closed / rows.length : null
  });
}

/* -------------------------- learning: scoring (server authority) -------- */
function scoreAgainst(descriptor, row) {
  const w = { dealType: 0.35, industry: 0.35, band: 0.15, risk: 0.15 };
  const dealType = ((descriptor.dealType || "VC") === row.deal_type) ? 1 : 0;
  const industry = industryScore(descriptor.industry, row.industry);
  const band = bandScore(bandFor(descriptor.value), row.value_band);
  const risk = riskProfileScore(descriptor.riskCounts, safeParse(row.analysis).riskCounts);
  return w.dealType * dealType + w.industry * industry + w.band * band + w.risk * risk;
}

const STOP = new Set(["the", "and", "of", "for", "a", "an", "inc", "llc", "corp", "co", "services", "solutions", "technologies", "technology", "group", "holdings"]);
function tokenize(text) { return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)); }
function industryScore(a, b) {
  const ta = new Set(tokenize(a)); const tb = tokenize(b);
  if (!ta.size || !tb.length) return 0;
  const overlap = tb.filter((w) => ta.has(w)).length;
  const union = new Set([...ta, ...tb]).size;
  return union ? overlap / union : 0;
}
const BANDS = ["<$25M", "$25M–$100M", "$100M–$500M", ">$500M", "Undisclosed"];
function bandScore(a, b) {
  if (a === b) return 1;
  const ia = BANDS.indexOf(a), ib = BANDS.indexOf(b);
  if (ia < 0 || ib < 0 || a === "Undisclosed" || b === "Undisclosed") return 0.25;
  return Math.abs(ia - ib) === 1 ? 0.5 : 0;
}
function riskProfileScore(a, b) {
  const keys = ["Critical", "High", "Medium", "Low"];
  const va = keys.map((k) => (a && a[k]) || 0);
  const vb = keys.map((k) => (b && b[k]) || 0);
  const dot = va.reduce((s, x, i) => s + x * vb[i], 0);
  const ma = Math.sqrt(va.reduce((s, x) => s + x * x, 0));
  const mb = Math.sqrt(vb.reduce((s, x) => s + x * x, 0));
  return ma && mb ? dot / (ma * mb) : 0;
}
function summarize(comparableDeals) {
  if (!comparableDeals.length) return null;
  const rated = comparableDeals.map((d) => d.outcome.successRating).filter((n) => n != null);
  const avgSuccess = rated.length ? rated.reduce((s, n) => s + n, 0) / rated.length : null;
  const closed = comparableDeals.filter((d) => d.outcome.closed).length;
  const tally = (get) => {
    const counts = {};
    comparableDeals.forEach((d) => (get(d) || []).forEach((t) => {
      const key = t.toLowerCase();
      counts[key] = counts[key] || { label: t, n: 0 };
      counts[key].n += 1;
    }));
    return Object.values(counts).sort((a, b) => b.n - a.n).map((c) => c.label);
  };
  return {
    count: comparableDeals.length,
    closedRate: comparableDeals.length ? closed / comparableDeals.length : null,
    avgSuccess,
    commonMaterializedRisks: tally((d) => d.outcome.materializedRisks).slice(0, 6),
    commonMissedRisks: tally((d) => d.outcome.missedRisks).slice(0, 6),
    poorTrackRecord: avgSuccess != null && comparableDeals.length >= 2 && avgSuccess <= 2.4,
    strongTrackRecord: avgSuccess != null && comparableDeals.length >= 2 && avgSuccess >= 4
  };
}

function bandFor(raw) {
  const n = parseMoney(raw);
  if (n == null) return "Undisclosed";
  if (n < 25e6) return "<$25M";
  if (n < 100e6) return "$25M–$100M";
  if (n < 500e6) return "$100M–$500M";
  return ">$500M";
}
function parseMoney(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") return isFinite(raw) ? raw : null;
  const text = String(raw).trim().toLowerCase();
  const m = /(-?[\d,.]+)\s*(b|bn|billion|m|mm|million|k|thousand)?/.exec(text);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(num)) return null;
  const unit = m[2] || "";
  const mult = /^b/.test(unit) ? 1e9 : /^m/.test(unit) ? 1e6 : /^k|^t/.test(unit) ? 1e3 : 1;
  return num * mult;
}

/* ----------------------------------------------- learning: row helpers */
function rowToOutcome(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    sourceProjectId: row.source_project_id,
    industry: row.industry,
    dealType: row.deal_type,
    valueBand: row.value_band,
    analysis: safeParse(row.analysis),
    outcome: safeParse(row.outcome),
    consent: row.consent === 1,
    createdAt: row.created_at
  };
}
function cleanList(arr) {
  return (Array.isArray(arr) ? arr : String(arr || "").split(/[\n,;]/))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
}
function clampRating(v) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return null;
  return Math.min(5, Math.max(1, n));
}
function safeParse(text) { try { return JSON.parse(text); } catch { return {}; } }

/* ----------------------------------------------------------- LLM proxy */
// The model API key lives ONLY here as a Worker secret — never shipped to the
// browser (fixes the prototype's client-side key). Every call is authenticated
// and metered per user/day so a leaked session can't run up an unbounded bill.
const LLM_DAILY_LIMIT = 200;

// Lets the frontend know whether the server has an AI key, without exposing it.
async function llmStatus(request, env) {
  await requireUser(request, env);
  const provider = (env.DEFAULT_LLM_PROVIDER || "claude").toLowerCase();
  const configured = Boolean(provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY)
    || Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY);
  return json({ configured, provider, dailyLimit: LLM_DAILY_LIMIT });
}

async function llmProxy(request, env) {
  const user = await requireUser(request, env);
  const { system, user: userMsg, provider: reqProvider, model: reqModel, maxTokens } = await readJson(request);
  if (!system || !userMsg) return json({ error: "system and user are required." }, 400);

  const provider = (reqProvider || env.DEFAULT_LLM_PROVIDER || "claude").toLowerCase();
  const key = provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
  if (!key) return json({ error: `Server has no ${provider} key configured.` }, 503);

  // ---- per-user daily rate limit ----
  const day = new Date().toISOString().slice(0, 10);
  const usage = await env.DB.prepare("SELECT calls FROM llm_usage WHERE user_id = ? AND day = ?").bind(user.id, day).first();
  if (usage && usage.calls >= LLM_DAILY_LIMIT) {
    return json({ error: `Daily analysis limit reached (${LLM_DAILY_LIMIT}). Try again tomorrow.` }, 429);
  }

  let text;
  try {
    text = provider === "openai"
      ? await callOpenAI(system, userMsg, key, reqModel || "gpt-4o")
      : await callClaude(system, userMsg, key, reqModel || "claude-opus-4-8", maxTokens || 2000);
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  // Best-effort metering (never block the response on the counter write).
  await env.DB.prepare(
    `INSERT INTO llm_usage (id, user_id, day, calls) VALUES (?,?,?,1)
     ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1`
  ).bind(uuid(), user.id, day).run().catch(() => {});

  return json({ text });
}

async function callClaude(system, user, apiKey, model, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] })
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).map((b) => b.text || "").join("");
}

async function callOpenAI(system, user, apiKey, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

/* ------------------------------------------------------- session helpers */
async function withSession(env, user, res) {
  const token = randomToken();
  const id = await sha256Hex(token);
  const now = Date.now();
  const expires = new Date(now + SESSION_TTL_DAYS * 86400_000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)")
    .bind(id, user.id, new Date(now).toISOString(), expires).run();
  res.headers.append("Set-Cookie", sessionCookie(token));
  return res;
}

async function currentUser(request, env) {
  const token = tokenFromRequest(request);
  if (!token) return null;
  const id = await sha256Hex(token);
  const session = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    return null;
  }
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(session.user_id).first();
}

function tokenFromRequest(request) {
  const auth = request.headers.get("Authorization");
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const cookie = request.headers.get("Cookie") || "";
  const match = /(?:^|;\s*)sdd_session=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

function sessionCookie(token) {
  const maxAge = SESSION_TTL_DAYS * 86400;
  return `sdd_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function clearCookie() {
  return "sdd_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

/* -------------------------------------------------------------- crypto */
async function hashPassword(password, salt) {
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial, 256
  );
  return hex(new Uint8Array(bits));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return hex(new Uint8Array(digest));
}

// Constant-time-ish string compare to avoid leaking hash bytes via timing.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function randomToken() { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
function randomHex(bytes) { return hex(crypto.getRandomValues(new Uint8Array(bytes))); }
function uuid() { return crypto.randomUUID(); }
function hex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function base64url(bytes) {
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* --------------------------------------------------------------- utils */
function normalizeEmail(email) { return String(email || "").trim().toLowerCase(); }
function publicUser(u) { return { id: u.id, email: u.email, name: u.name, provider: u.provider, picture: u.picture || null }; }

async function readJson(request) {
  try { return await request.json(); }
  catch { const e = new Error("Invalid JSON body."); e.status = 400; throw e; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function cors(request, res) {
  const origin = request.headers.get("Origin");
  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Access-Control-Allow-Credentials", "true");
    res.headers.set("Vary", "Origin");
  }
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  return res;
}

// Exported for later phases (projects/outcomes/documents) so they can gate on auth.
export { currentUser };

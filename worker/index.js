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

  return json({ error: "Not found" }, 404);
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

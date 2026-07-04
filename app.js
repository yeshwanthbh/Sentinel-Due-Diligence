/* Sentinel DD — UI orchestration layer.
 * Delegates document processing, evidence, agents, review, and export to the js/ modules. */
const SESSION_KEY = "sentinel-dd-session";
const { cryptoId, clone, escapeHtml } = window.DD.util;

const navItems = [
  ["dashboard", "Dashboard", "layout-dashboard"],
  ["projects", "Projects", "briefcase-business"],
  ["data-room", "Data Room", "database"],
  ["analysis", "Analysis", "activity"],
  ["findings", "Findings Center", "list-checks"],
  ["evidence", "Evidence Explorer", "search-check"],
  ["missing", "Missing Information", "circle-help"],
  ["risks", "Risk Center", "shield-alert"],
  ["memo", "Investment Memo", "file-pen-line"],
  ["reports", "Reports", "download"],
  ["settings", "Settings", "settings"]
];

let currentUser = null;
let authMode = "login";
let projects = [];
let currentProject = null;
let currentFindingTab = null;
let saveTimer = null;
let evidenceSelection = null;
let reviewTarget = null;

const $ = (sel) => document.querySelector(sel);
const navList = $("#navList");
const toast = $("#toast");

function icon(name) { return `<i data-lucide="${name}"></i>`; }
function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2800);
}

function requireProject() {
  if (!currentProject) { showToast("Create a project first."); return false; }
  return true;
}

/* ------------------------------------------------------------------ auth */
async function createAccount(formData) {
  const email = String(formData.get("email")).trim().toLowerCase();
  if (await window.DD.store.getByIndex("users", "email", email)) throw new Error("An account with that email already exists.");
  const salt = window.DD.db.makeSalt();
  const user = {
    id: cryptoId(),
    name: String(formData.get("name")).trim() || email.split("@")[0],
    email, salt,
    passwordHash: await window.DD.db.hashPassword(String(formData.get("password")), salt),
    createdAt: new Date().toISOString()
  };
  await window.DD.store.put("users", user);
  return user;
}

async function login(formData) {
  const email = String(formData.get("email")).trim().toLowerCase();
  const user = await window.DD.store.getByIndex("users", "email", email);
  if (!user) throw new Error("No account found for that email.");
  if (!user.passwordHash && user.provider === "google") throw new Error("This account uses Google sign-in. Use the “Continue with Google” button.");
  const passwordHash = await window.DD.db.hashPassword(String(formData.get("password")), user.salt);
  if (passwordHash !== user.passwordHash) throw new Error("Incorrect password.");
  return user;
}

async function setSession(user) {
  currentUser = user;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ userId: user.id }));
  await loadProjects();
  $("#authScreen").classList.add("hidden");
  $("#appShell").classList.remove("locked");
  $("#userLabel").textContent = user.name;
  renderAll();
}

async function restoreSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return;
  try {
    const { userId } = JSON.parse(raw);
    const user = await window.DD.store.get("users", userId);
    if (user) await setSession(user);
  } catch { localStorage.removeItem(SESSION_KEY); }
}

/* ------------------------------------------------------ Google sign-in (GIS) */
const GOOGLE_CLIENT_ID_KEY = "sentinel-dd-google-client-id";
// The developer sets the Client ID once in config.js; localStorage is only a
// quick-testing override. config.js wins so the button "just works" for everyone.
function getGoogleClientId() {
  const fromConfig = ((window.SENTINEL_CONFIG && window.SENTINEL_CONFIG.googleClientId) || "").trim();
  return fromConfig || (localStorage.getItem(GOOGLE_CLIENT_ID_KEY) || "").trim();
}
function setGoogleClientId(id) { localStorage.setItem(GOOGLE_CLIENT_ID_KEY, (id || "").trim()); }
function googleRunnableOrigin() { return window.location.protocol === "http:" || window.location.protocol === "https:"; }

// Decode a Google ID-token JWT payload (base64url) without a backend. For a local
// prototype this is fine; a production app would verify the signature server-side.
function decodeJwtPayload(token) {
  const part = token.split(".")[1];
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const json = decodeURIComponent(
    atob(base64).split("").map((c) => `%${("00" + c.charCodeAt(0).toString(16)).slice(-2)}`).join("")
  );
  return JSON.parse(json);
}

// Find or create a local user for a Google identity, keyed by email.
async function upsertGoogleUser({ email, name, sub, picture }) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) throw new Error("Google did not return an email address.");
  let user = await window.DD.store.getByIndex("users", "email", normalized);
  if (user) {
    // Attach the Google identity to an existing account and refresh profile bits.
    user.provider = "google";
    user.googleId = sub || user.googleId || null;
    if (picture) user.picture = picture;
    if (!user.name && name) user.name = name;
    await window.DD.store.put("users", user);
    return user;
  }
  user = {
    id: cryptoId(),
    name: (name || normalized.split("@")[0]).trim(),
    email: normalized,
    provider: "google",
    googleId: sub || null,
    picture: picture || null,
    createdAt: new Date().toISOString()
  };
  await window.DD.store.put("users", user);
  return user;
}

async function handleGoogleCredential(response) {
  try {
    if (!response || !response.credential) throw new Error("No credential returned by Google.");
    const claims = decodeJwtPayload(response.credential);
    const user = await upsertGoogleUser({ email: claims.email, name: claims.name, sub: claims.sub, picture: claims.picture });
    await setSession(user);
    showToast(`Signed in as ${user.name} via Google.`);
  } catch (error) {
    console.error(error);
    showToast(`Google sign-in failed: ${error.message}`);
  }
}

function googleReady() { return Boolean(window.google && window.google.accounts && window.google.accounts.id); }

// Render the official Google button when everything is in place; otherwise show a
// single clear message about what's missing. No pop-up prompts in the normal flow.
function initGoogleSignIn() {
  const hint = $("#googleHint");
  const slot = $("#googleButton");
  const divider = $("#socialDivider");
  const setupLink = $("#configureGoogle");
  const clientId = getGoogleClientId();
  const reset = () => { if (slot) slot.innerHTML = ""; };
  const showSetupLink = (on) => { if (setupLink) setupLink.hidden = !on; };
  const showDivider = (on) => { if (divider) divider.hidden = !on; };

  // Google Identity Services cannot run from a file:// page.
  if (!googleRunnableOrigin()) {
    reset(); showDivider(true); showSetupLink(false);
    if (hint) hint.textContent = "To use Google sign-in, open this app from a web address (e.g. http://localhost:4599) — it can’t run from a file:// page.";
    return;
  }
  // No Client ID configured yet (developer setup step).
  if (!clientId) {
    reset(); showDivider(true); showSetupLink(true);
    if (hint) hint.textContent = "Add your Google OAuth Client ID in config.js to enable Google sign-in.";
    return;
  }
  // Library still loading (async) — retry shortly.
  if (!googleReady()) {
    showDivider(true);
    if (hint) hint.textContent = "Loading Google sign-in…";
    window.setTimeout(initGoogleSignIn, 400);
    return;
  }
  try {
    window.google.accounts.id.initialize({ client_id: clientId, callback: handleGoogleCredential, auto_select: false });
    showDivider(true); showSetupLink(false);
    reset();
    // The official, Google-rendered button — same as other companies' pages.
    window.google.accounts.id.renderButton(slot, { theme: "outline", size: "large", type: "standard", text: "continue_with", shape: "pill", logo_alignment: "left", width: 320 });
    if (hint) hint.textContent = "";
  } catch (error) {
    console.error(error);
    showDivider(true); showSetupLink(true);
    if (hint) hint.textContent = `Google sign-in error: ${error.message}. Check the Client ID and that this origin is an authorized JavaScript origin.`;
  }
}

// Quick-testing convenience only (hidden unless no Client ID is configured):
// lets you paste an ID without editing config.js.
function promptForGoogleClientId() {
  const entered = window.prompt(
    "For quick testing you can paste a Google OAuth Client ID here.\n" +
    "The proper place is config.js so it persists for everyone.",
    getGoogleClientId()
  );
  if (entered === null) return;
  setGoogleClientId(entered);
  showToast(entered.trim() ? "Client ID saved for this browser." : "Client ID cleared.");
  initGoogleSignIn();
}

/* --------------------------------------------------------------- projects */
function newProjectRecord({ company, industry, type, team, value, close }, ownerId, overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || cryptoId(),
    ownerId, name: company, industry, type: type || "Venture Capital",
    dealType: overrides.dealType || "VC",
    status: overrides.status || "Data Room", progress: overrides.progress ?? 0,
    team: team || "Unassigned", value: value || "Not provided", close: close || "TBD",
    createdAt: now, updatedAt: now,
    documents: overrides.documents || [],
    coverage: overrides.coverage || [],
    findings: overrides.findings || {},
    evidence: overrides.evidence || [],
    research: overrides.research || null,
    financial: overrides.financial || null,
    crossValidation: overrides.crossValidation || null,
    riskRegister: overrides.riskRegister || null,
    risks: overrides.risks || {},
    recommendation: overrides.recommendation || null,
    financialInput: overrides.financialInput || "",
    memoHtml: overrides.memoHtml || "<h2>Executive Summary</h2><p>Upload documents and run the AI agents to draft this memorandum. Every statement will reference supporting evidence.</p>",
    agentRuns: overrides.agentRuns || {},
    reviewLog: overrides.reviewLog || [],
    auditLog: overrides.auditLog || [{ at: now, action: "Project created" }]
  };
}

/* One-time removal of the legacy auto-seeded demo deals so existing accounts
 * become a clean slate. New accounts no longer seed anything. */
async function clearLegacyDemos() {
  if (localStorage.getItem("sentinel-dd-demos-cleared")) return;
  const seedNames = new Set(["HelioGrid Energy", "Northstar Health", "Meridian Robotics", "Cobalt Payroll"]);
  try {
    const all = await window.DD.store.getAllByIndex("projects", "ownerId", currentUser.id);
    await Promise.all(all.filter((p) => seedNames.has(p.name)).map((p) => window.DD.store.del("projects", p.id)));
  } catch { /* ignore */ }
  localStorage.setItem("sentinel-dd-demos-cleared", "1");
}

async function loadProjects(preferredId) {
  await clearLegacyDemos();
  projects = await window.DD.store.getAllByIndex("projects", "ownerId", currentUser.id);
  projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  currentProject = projects.find((p) => p.id === preferredId) || projects[0] || null;
}

async function saveCurrentProject(reason = "Project saved") {
  if (!currentProject) return;
  currentProject.updatedAt = new Date().toISOString();
  currentProject.auditLog = currentProject.auditLog || [];
  currentProject.auditLog.unshift({ at: currentProject.updatedAt, action: reason });
  currentProject.auditLog = currentProject.auditLog.slice(0, 20);
  await window.DD.store.put("projects", currentProject);
  const idx = projects.findIndex((p) => p.id === currentProject.id);
  if (idx >= 0) projects[idx] = currentProject;
}

function scheduleSave(reason) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveCurrentProject(reason), 400);
}

/* --------------------------------------------------------------- rendering */
function initNav() {
  navList.innerHTML = navItems.map(([id, label, iconName]) => `
    <button class="nav-item ${id === "dashboard" ? "active" : ""}" data-target="${id}" title="${escapeHtml(label)}">
      ${icon(iconName)}<span>${escapeHtml(label)}</span>
    </button>`).join("");
}

function showPage(id) {
  document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === id));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.target === id));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function countFindings(project, predicate) {
  return Object.values(project.findings || {}).flat().filter(predicate || (() => true)).length;
}

function renderDashboard() {
  const cards = document.querySelectorAll("#dashboard .metric-card");
  const totalDocs = projects.reduce((s, p) => s + (p.documents?.length || 0), 0);
  const totalEvidence = projects.reduce((s, p) => s + (p.evidence?.length || 0), 0);
  const openFindings = projects.reduce((s, p) => s + countFindings(p, (f) => f.status !== "Approved" && f.status !== "Rejected"), 0);
  const values = [
    [projects.length, "Saved diligence projects"],
    [totalDocs, "Documents processed"],
    [totalEvidence, "Evidence citations"],
    [openFindings, "Findings awaiting review"]
  ];
  cards.forEach((card, i) => { card.querySelector("strong").textContent = values[i][0]; card.querySelector("small").textContent = values[i][1]; });

  $("#projectTable").innerHTML = projects.map((p) => `
    <div class="table-row">
      <div><div class="row-title">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.type)} • ${p.documents?.length || 0} docs • ${countFindings(p)} findings</div></div>
      <span class="status-badge info">${escapeHtml(p.status)}</span>
      <div class="progress-track"><span style="width:${p.progress}%"></span></div>
      <button class="secondary-button" data-open-project="${p.id}">${icon("folder-open")}Open</button>
      <button class="secondary-button" data-delete-project="${p.id}" title="Delete this project" style="color:var(--danger);">${icon("trash-2")}</button>
    </div>`).join("");

  $("#agentStack").innerHTML = "";

  $("#notifications").innerHTML = (currentProject.auditLog || []).slice(0, 5)
    .map((item) => `<article class="notification-item"><strong>${escapeHtml(item.action)}</strong><span>${new Date(item.at).toLocaleString()}</span></article>`).join("")
    || `<p class="muted">No activity yet.</p>`;

  $("#recentReports").innerHTML = [
    ["PDF Report", "download", "exportPdf"], ["Word Memo", "file-text", "exportWord"],
    ["Excel Workbook", "table", "exportExcel"], ["PowerPoint", "presentation", "exportPptx"]
  ].map(([label, ic, fn]) => `<article class="report-card"><div>${icon(ic)}<strong>${label}</strong><span>${escapeHtml(currentProject.name)}</span></div><button class="ghost-button" data-export="${fn}">Export</button></article>`).join("");
}

function renderSidebar() {
  $("#projectSwitcher").innerHTML = projects.map((p) => `<option value="${p.id}" ${p.id === currentProject.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("");
  $("#sidebarProjectName").textContent = currentProject.name;
  $("#sidebarProjectMeta").textContent = `${currentProject.type}, ${currentProject.value}`;
  $("#sidebarProjectProgress").style.width = `${currentProject.progress}%`;
  $("#dataRoomTitle").textContent = `${currentProject.name} — data room`;
  $("#uploadZoneTitle").textContent = `Drop documents for ${currentProject.name}`;
  $("#coverageHeading").textContent = `${currentProject.type} coverage`;
}

function renderProjectsPage() {
  const columns = ["Data Room", "AI Review", "Findings", "IC Memo"];
  $("#projectKanban").innerHTML = columns.map((column) => `
    <section class="kanban-column">
      <div class="kanban-title"><span>${column}</span><span>${projects.filter((p) => p.status === column).length}</span></div>
      ${projects.filter((p) => p.status === column).map((p) => `
        <article class="project-card">
          <strong>${escapeHtml(p.name)}</strong>
          <p>${escapeHtml(p.industry)} • ${p.documents?.length || 0} docs • ${p.progress}% complete</p>
          <div class="progress-track"><span style="width:${p.progress}%"></span></div>
          <div class="button-row"><button class="ghost-button" data-open-project="${p.id}">${icon("folder-open")}Open</button><button class="ghost-button" data-delete-project="${p.id}" style="color:var(--danger);">${icon("trash-2")}</button></div>
        </article>`).join("") || `<p class="muted">No projects in this stage.</p>`}
    </section>`).join("");
}

/* ---- Data Room ---- */
function renderDataRoom() {
  if (!currentProject) return;
  const project = currentProject;
  const coverage = window.DD.classify.coverage(project.documents || [], project.dealType || "VC");
  $("#coverageList").innerHTML = coverage.map((c) => `
    <div class="coverage-item">
      <div><strong>${escapeHtml(c.category)}</strong><div class="progress-track"><span style="width:${c.pct}%"></span></div></div>
      <span class="status-badge ${c.state}">${c.count} file${c.count === 1 ? "" : "s"}</span>
    </div>`).join("");

  const missing = window.DD.classify.missingCategories(project.documents || [], project.dealType || "VC");
  $("#missingInline").innerHTML = missing.length
    ? `<div class="missing-chip-row"><span class="eyebrow">Missing for ${project.dealType || "VC"}</span>${missing.map((m) => `<span class="chip danger">${escapeHtml(m)}</span>`).join("")}</div>`
    : `<div class="missing-chip-row"><span class="chip success">All required categories present</span></div>`;

  const cats = ["all", ...window.DD.classify.categories, "Uncategorized"];
  const filter = $("#categoryFilter");
  const currentCat = filter.value || "all";
  filter.innerHTML = cats.map((c) => `<option value="${c}" ${c === currentCat ? "selected" : ""}>${c === "all" ? "All categories" : c}</option>`).join("");

  const rows = window.DD.dataroom.inventory(project, { search: $("#dataRoomSearch").value, category: filter.value });
  $("#processingSummary").textContent = `${project.documents?.length || 0} documents • ${project.evidence?.length || 0} evidence`;
  $("#fileTable").innerHTML = rows.length ? rows.map((doc) => `
    <div class="file-row">
      <div><div class="row-title">${escapeHtml(doc.name)}</div><div class="row-sub">${doc.pageCount || 0} pages • ${doc.wordCount || 0} words${doc.ocrUsed ? " • OCR" : ""} • ${new Date(doc.uploadedAt).toLocaleString()}</div></div>
      <span>${escapeHtml(doc.category)}<br><small class="muted">${escapeHtml(doc.docType)}</small></span>
      <span class="status-badge ${doc.status === "Duplicate" ? "warning" : doc.status === "Error" ? "danger" : "success"}">${escapeHtml(doc.status)}</span>
      <span class="muted">${escapeHtml(doc.duplicate)}</span>
      <strong>${escapeHtml(doc.confidence)}</strong>
    </div>`).join("")
    : `<p class="muted">No documents match. Upload files to build the inventory.</p>`;
}

// Recursively collect File objects from a drop, walking into any dropped folders.
// Falls back to dataTransfer.files when the directory-entry API is unavailable.
async function filesFromDataTransfer(dataTransfer) {
  const items = dataTransfer.items;
  const supportsEntries = items && items.length && typeof items[0].webkitGetAsEntry === "function";
  if (!supportsEntries) return Array.from(dataTransfer.files || []);

  const readEntries = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  const fileFromEntry = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

  async function walk(entry, out) {
    if (!entry) return;
    if (entry.isFile) {
      try { out.push(await fileFromEntry(entry)); } catch { /* skip unreadable file */ }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns results in batches; loop until it returns an empty array.
      let batch;
      do {
        batch = await readEntries(reader);
        for (const child of batch) await walk(child, out);
      } while (batch.length);
    }
  }

  const entries = Array.from(items).map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return Array.from(dataTransfer.files || []);
  const out = [];
  for (const entry of entries) await walk(entry, out);
  return out;
}

async function handleUpload(files) {
  if (!requireProject()) return;
  files = Array.from(files || []);
  if (!files.length) return;
  showPage("data-room");
  const queue = $("#uploadQueue");
  queue.innerHTML = "";
  const bars = {};
  const onProgress = (info) => {
    if (!bars[info.id]) {
      const el = document.createElement("div");
      el.className = "upload-item";
      el.innerHTML = `<div class="upload-item-top"><strong>${escapeHtml(info.name)}</strong><span class="upload-stage">queued</span></div><div class="progress-track"><span style="width:0%"></span></div>`;
      queue.appendChild(el);
      bars[info.id] = el;
    }
    bars[info.id].querySelector(".upload-stage").textContent = info.stage;
    bars[info.id].querySelector(".progress-track span").style.width = `${info.pct}%`;
    if (info.stage === "done") bars[info.id].classList.add("done");
  };
  try {
    const result = await window.DD.dataroom.ingest(currentProject, files, { onProgress });
    currentProject.progress = Math.min(96, (currentProject.progress || 0) + result.added.length * 3);
    if (currentProject.status === "Data Room" && currentProject.documents.length) currentProject.status = "AI Review";
    await saveCurrentProject(`${result.added.length} document(s) processed`);
    renderProjectSurfaces();
    let msg = `${result.added.length} document(s) processed, categorized, and stored.`;
    if (result.skipped.length) msg += ` ${result.skipped.length} skipped.`;
    if (result.missing.length) msg += ` Missing: ${result.missing.join(", ")}.`;
    showToast(msg);
  } catch (error) {
    console.error(error);
    showToast(`Upload failed: ${error.message}`);
  }
}

/* ---- Analysis Orchestrator ---- */
function renderAnalysis() {
  if (!currentProject) return;
  const runs = currentProject.agentRuns || {};
  const allRun = runs.__orchestrator;
  // Badge reflects the engine that actually produced this analysis, not just whether a key exists.
  let badge = window.DD.llm.isConfigured() ? `${window.DD.llm.getConfig().provider === "openai" ? "OpenAI" : "Claude"}` : "Heuristic engine";
  let badgeClass = "info";
  if (allRun) {
    if (allRun.silentFallback) { badge = "Heuristic (model unreachable)"; badgeClass = "warning"; }
    else if (allRun.source === "model") { badge = "Live model"; badgeClass = "success"; }
    else if (allRun.source === "mixed") { badge = `Mixed (${allRun.modelRuns}/${allRun.modelable} live)`; badgeClass = "warning"; }
    else { badge = "Heuristic engine"; badgeClass = "info"; }
  }
  $("#analysisProviderBadge").textContent = badge;
  $("#analysisProviderBadge").className = `status-badge ${badgeClass}`;

  const agents = Object.entries(window.DD.agents.REGISTRY);
  const progress = agents.map(([key, a]) => {
    const runInfo = runs[key];
    const done = Boolean(runInfo);
    // "cross" agents are heuristic by design; only flag model/heuristic for the rest.
    const isModel = runInfo && runInfo.source === "model";
    const tag = !done ? "" : runInfo.kind === "cross" ? "" : isModel ? " · model" : " · heuristic";
    const tagClass = isModel ? "success" : "info";
    return `<div class="agent-run-item">
      <div class="agent-run-top"><strong>${escapeHtml(a.name)}</strong><span class="status-badge ${done ? tagClass : "info"}">${done ? `✓${tag}` : "—"}</span></div>
      <div class="progress-track"><span style="width:${done ? 100 : 0}%"></span></div>
    </div>`;
  }).join("");

  let summary;
  if (!allRun) {
    summary = `<p>Run the analysis to orchestrate all ${agents.length} specialist agents through your documents.</p>`;
  } else if (allRun.silentFallback) {
    const errLine = allRun.modelError
      ? `<br><span class="inline-error">API error: ${escapeHtml(allRun.modelError)}</span>`
      : "";
    summary = `<p><strong>Analysis complete — heuristic engine.</strong> An API key is configured but the live model did not respond for any agent, so deterministic fallbacks were used.${errLine}</p><p class="muted">Note: the analysis call adds a JSON-response requirement and larger payload the connection test doesn't, so a passing test can still fail here. The error above is the actual cause — re-run after resolving it.</p>`;
  } else if (allRun.source === "mixed") {
    summary = `<p><strong>Analysis complete — mixed.</strong> ${allRun.modelRuns} of ${allRun.modelable} agents used the live model; the rest fell back to heuristics.</p>`;
  } else if (allRun.source === "model") {
    summary = `<p><strong>Analysis complete — live model.</strong> All ${allRun.modelable} model-driven agents ran on ${escapeHtml(window.DD.llm.getConfig().provider === "openai" ? "OpenAI" : "Claude")}.</p>`;
  } else {
    summary = `<p><strong>Analysis complete — heuristic engine.</strong> No API key configured; add one in Settings for AI-generated intelligence.</p>`;
  }

  $("#orchestratorProgress").innerHTML = `${summary}<div class="agent-run-list">${progress}</div>`;
}

// Yield to the browser so a progress step actually paints before the next agent runs.
function paintYield(ms = 240) {
  return new Promise((resolve) => window.requestAnimationFrame(() => window.setTimeout(resolve, ms)));
}

// Update the memo-page loading bar. Pass { show:false } to hide it.
function setMemoProgress({ pct, label, sub, show } = {}) {
  const wrap = $("#memoProgress");
  if (!wrap) return;
  if (show === false) { wrap.hidden = true; return; }
  wrap.hidden = false;
  if (pct != null) { $("#memoProgressBar").style.width = `${pct}%`; $("#memoProgressPct").textContent = `${pct}%`; }
  if (label != null) $("#memoProgressLabel").textContent = label;
  if (sub != null) $("#memoProgressSub").textContent = sub;
}

// Live per-agent progress on the Analysis page while the orchestrator runs.
// activeIndex = the agent currently running; everything before it is done.
function renderOrchestratorLive(activeIndex, total, activeName) {
  const agents = Object.entries(window.DD.agents.REGISTRY);
  const overallPct = Math.round((Math.min(activeIndex, total) / total) * 100);
  const rows = agents.map(([key, a], idx) => {
    const done = idx < activeIndex;
    const active = idx === activeIndex;
    const pct = done ? 100 : active ? 65 : 0;
    const badge = done ? '<span class="status-badge success">✓</span>'
      : active ? '<span class="status-badge info">running…</span>'
      : '<span class="status-badge info">—</span>';
    return `<div class="agent-run-item ${active ? "active" : ""}">
      <div class="agent-run-top"><strong>${escapeHtml(a.name)}</strong>${badge}</div>
      <div class="progress-track"><span style="width:${pct}%"></span></div>
    </div>`;
  }).join("");
  const overall = `<div class="orchestrator-overall">
    <div class="orchestrator-overall-head"><strong>Running analysis…</strong><span>${overallPct}%${activeName ? ` • ${escapeHtml(activeName)}` : ""}</span></div>
    <div class="progress-track"><span style="width:${overallPct}%"></span></div>
  </div>`;
  $("#orchestratorProgress").innerHTML = `${overall}<div class="agent-run-list">${rows}</div>`;
}

let orchestratorRunning = false;

async function runOrchestrator() {
  if (!requireProject()) return;
  if (orchestratorRunning) return;
  if (!currentProject.documents.length) { showToast("Upload documents first."); return; }
  const total = Object.keys(window.DD.agents.REGISTRY).length;
  orchestratorRunning = true;
  showToast("Starting diligence analysis orchestrator…");
  $("#runOrchestrator").disabled = true;
  $("#generateMemo").disabled = true;
  renderOrchestratorLive(0, total, "");
  setMemoProgress({ show: true, pct: 0, label: "Generating investment memo…", sub: "Starting orchestrator…" });

  // Fires before each agent runs: mark prior agents done, this one active, and paint.
  const onStep = async (key, name, i, count) => {
    const pct = Math.round((i / count) * 100);
    renderOrchestratorLive(i, count, name);
    setMemoProgress({ pct, sub: `Analyzing: ${name}` });
    await paintYield();
  };

  try {
    const results = await window.DD.agents.runAll(currentProject, onStep);
    // Show the completed 100% state briefly before the final summary replaces it.
    renderOrchestratorLive(total, total, "");
    setMemoProgress({ pct: 100, label: "Memo ready", sub: "Analysis complete." });
    await paintYield(300);
    // Derive the true engine from what the agents ACTUALLY did, not from whether a
    // key merely exists. Agents fall back to heuristics silently when a model call
    // fails (bad key, CORS, quota), so trust the recorded per-agent source instead.
    const modelable = results.filter((r) => r.kind !== "cross");
    const modelRuns = modelable.filter((r) => r.source === "model").length;
    const keyConfigured = window.DD.llm.isConfigured();
    // Capture the first real API error so we can tell the user WHY agents fell back,
    // instead of a mysterious "heuristic engine" with no explanation.
    const firstError = (modelable.find((r) => r.modelError) || {}).modelError || null;
    let source;
    if (modelRuns === modelable.length && modelRuns > 0) source = "model";
    else if (modelRuns === 0) source = "heuristic";
    else source = "mixed";
    currentProject.agentRuns.__orchestrator = {
      at: new Date().toISOString(), source,
      modelRuns, modelable: modelable.length,
      // Flag the deceptive case: a key is set but the live model never actually ran.
      keyConfigured, silentFallback: keyConfigured && modelRuns === 0,
      modelError: firstError
    };
    currentProject.progress = 96;
    currentProject.status = "IC Memo";
    await saveCurrentProject("Orchestrator analysis complete");
    renderProjectSurfaces();
    // Leave "Memo ready" visible briefly, then fade the memo loading bar out.
    window.setTimeout(() => setMemoProgress({ show: false }), 1200);
    if (keyConfigured && modelRuns === 0) {
      showToast("Analysis ran on the heuristic engine — the live model never responded. Check Settings → Test connection.");
    } else if (source === "mixed") {
      showToast(`Analysis complete. ${modelRuns} of ${modelable.length} agents used the live model; the rest used heuristics.`);
    } else {
      showToast("Analysis complete. Review findings, risks, and memo.");
    }
  } catch (error) {
    console.error(error);
    setMemoProgress({ show: false });
    showToast(`Analysis failed: ${error.message}`);
  } finally {
    orchestratorRunning = false;
    $("#runOrchestrator").disabled = false;
    $("#generateMemo").disabled = false;
  }
}

/* ---- Financial page ---- */
function renderFinancial() {
  const fin = currentProject.financial;
  $("#financialStatementInput").value = currentProject.financialInput || "";
  $("#financialSourceBadge").textContent = fin ? `${fin.source} engine` : "No data";
  $("#financialChecklist").innerHTML = ["Revenue", "Margins", "Working capital", "Debt & leverage", "Cash flow", "Valuation support", "Anomaly detection"]
    .map((w) => `<label class="check-row"><span class="check-dot ${fin ? "on" : ""}"></span>${w}</label>`).join("");

  $("#financialMetricGrid").innerHTML = (fin?.metrics || []).map((m) => `
    <article class="metric-card"><span>${escapeHtml(m.label)}</span><strong>${escapeHtml(String(m.value))}</strong><small>${escapeHtml(m.hint || "")}</small></article>`).join("")
    || `<p class="muted">Load or paste financial statement rows and run the analysis to compute metrics.</p>`;

  $("#financialTrendTable").innerHTML = (fin?.anomalies || []).map((a) => `
    <div class="file-row"><span class="status-badge ${a.severity === "High" ? "danger" : a.severity === "Medium" ? "warning" : "info"}">${a.severity}</span><span>${escapeHtml(a.text)}</span></div>`).join("")
    || `<p class="muted">No anomalies detected yet.</p>`;

  $("#valuationPanel").innerHTML = fin?.valuation ? `
    <p class="muted">Basis: ${escapeHtml(fin.valuation.basis)}</p>
    ${fin.valuation.rows.map((r) => `<div class="valuation-row"><span>${escapeHtml(r.label)}</span><strong>${escapeHtml(String(r.value))}</strong></div>`).join("")}`
    : `<p class="muted">Run the analysis to generate an indicative valuation bridge.</p>`;

  const finFindings = currentProject.findings.Financial || [];
  $("#financialFindingsList").innerHTML = finFindings.map((f) => findingCard(f, "Financial")).join("") || `<p class="muted">No financial findings yet.</p>`;
  $("#financialEvidenceList").innerHTML = window.DD.evidence.query(currentProject, { agent: "Financial Due Diligence Agent" })
    .map((e) => `<article class="evidence-mini"><strong>${escapeHtml(e.fact)}</strong><span>${escapeHtml(e.docName)}${e.page ? `, p.${e.page}` : ""} • ${e.confidence}%</span></article>`).join("")
    || `<p class="muted">No source-linked calculations yet.</p>`;
}

/* ---- Research page ---- */
function renderResearch() {
  const r = currentProject.research;
  if (!r) { $("#researchGrid").innerHTML = `<p class="muted">Run the Research Agent to gather company overview, competitors, executives, news, patents, filings, and market data with citations.</p>`; return; }
  const list = (title, items, render) => `<article class="panel"><div class="panel-head"><div><span class="eyebrow">${title}</span></div></div>${items && items.length ? items.map(render).join("") : `<p class="muted">None found.</p>`}</article>`;
  $("#researchGrid").innerHTML = `
    <article class="panel span-2"><div class="panel-head"><div><span class="eyebrow">Overview</span><h2>${escapeHtml(currentProject.name)}</h2></div><span class="status-badge info">${r.source} • ${escapeHtml(r.industry || "")}</span></div>
      <p>${escapeHtml(r.overview || "")}</p><p class="muted">${escapeHtml(r.businessModel || "")}</p></article>
    ${list("Competitors", r.competitors, (c) => `<div class="research-row"><strong>${escapeHtml(c.name)}</strong><span>${escapeHtml(c.note || "")}</span></div>`)}
    ${list("Executives", r.executives, (e) => `<div class="research-row"><strong>${escapeHtml(e.name)}</strong><span>${escapeHtml(e.role || "")}</span></div>`)}
    ${list("News", r.news, (n) => `<div class="research-row"><strong>${escapeHtml(n.headline)}</strong><span>${escapeHtml(n.summary || "")} ${escapeHtml(n.date || "")}</span></div>`)}
    ${list("Patents", r.patents, (p) => `<div class="research-row"><strong>${escapeHtml(p.title || p.note || "Patent")}</strong><span>${escapeHtml(p.note || "")}</span></div>`)}
    ${list("Regulatory filings", r.filings, (f) => `<div class="research-row"><strong>${escapeHtml(f.type || "Filing")}</strong><span>${escapeHtml(f.note || "")}</span></div>`)}
    <article class="panel"><div class="panel-head"><div><span class="eyebrow">Market</span></div></div><p><strong>Size:</strong> ${escapeHtml(r.market?.size || "—")} • <strong>Growth:</strong> ${escapeHtml(r.market?.growth || "—")}</p><p class="muted">${escapeHtml(r.market?.notes || "")}</p></article>
    <article class="panel span-2"><div class="panel-head"><div><span class="eyebrow">Citations &amp; confidence</span></div></div>
      ${(r.citations || []).map((c) => `<div class="research-row"><span>${escapeHtml(c.claim)}</span><span class="confidence">${escapeHtml(c.source || "")} • ${c.confidence || 60}%</span></div>`).join("") || `<p class="muted">No citations.</p>`}</article>`;
}

/* ---- Findings ---- */
function findingCard(f, bucket) {
  const sev = `severity-${f.severity.toLowerCase()}`;
  const statusClass = f.status === "Approved" ? "success" : f.status === "Rejected" ? "danger" : f.status === "Edited" ? "info" : "warning";
  return `<article class="finding-card">
    <div class="finding-card-top">
      <div><h2>${escapeHtml(f.title)}</h2><p class="muted">${escapeHtml(f.summary)}</p></div>
      <span class="${sev}"><strong>${escapeHtml(f.severity)}</strong></span>
    </div>
    <div class="finding-meta">
      <span>Confidence ${f.confidence}%</span>
      <span>${f.evidenceCount || 0} evidence</span>
      <span class="status-badge ${statusClass}">${escapeHtml(f.status)}</span>
      <span>${escapeHtml(f.agent || "")}</span>
    </div>
    <div class="finding-actions">
      <button class="secondary-button" data-finding="${f.id}" data-bucket="${escapeHtml(bucket)}" data-quick="Approved">${icon("check")}Approve</button>
      <button class="secondary-button" data-finding="${f.id}" data-bucket="${escapeHtml(bucket)}" data-quick="Rejected">${icon("x")}Reject</button>
      <button class="secondary-button" data-finding="${f.id}" data-bucket="${escapeHtml(bucket)}" data-review="Edited">${icon("pencil")}Edit</button>
      <button class="secondary-button" data-finding="${f.id}" data-bucket="${escapeHtml(bucket)}" data-review="Commented">${icon("message-square")}Comment</button>
      <button class="ghost-button" data-finding="${f.id}" data-bucket="${escapeHtml(bucket)}" data-review="History">${icon("history")}History</button>
      <button class="ghost-button" data-evidence-for="${f.id}">${icon("search-check")}Evidence</button>
    </div>
    ${(f.reviews && f.reviews.length) ? `<div class="review-strip">${f.reviews.slice(0, 2).map((rv) => `<span>${escapeHtml(rv.by)} ${escapeHtml(rv.action)}${rv.note ? `: ${escapeHtml(rv.note)}` : ""} • ${new Date(rv.at).toLocaleString()}</span>`).join("")}</div>` : ""}
  </article>`;
}

// A finding is "resolved" once approved or rejected — it leaves the review queue.
function isResolvedFinding(f) {
  return f.status === "Approved" || f.status === "Rejected";
}

function renderFindings() {
  const openFor = (t) => currentProject.findings[t].filter((f) => !isResolvedFinding(f));
  const allBuckets = Object.keys(currentProject.findings);
  // Only show tabs that still have open (unresolved) findings.
  const tabs = allBuckets.filter((t) => openFor(t).length);
  const totalFindings = allBuckets.reduce((n, t) => n + currentProject.findings[t].length, 0);
  if (!tabs.length) {
    $("#findingTabs").innerHTML = "";
    $("#findingList").innerHTML = totalFindings
      ? `<p class="muted">All findings reviewed. Approved and rejected findings are archived — see the review log or exports for the full record.</p>`
      : `<p class="muted">No findings yet. Upload documents and run the agents.</p>`;
    return;
  }
  if (!tabs.includes(currentFindingTab)) currentFindingTab = tabs[0];
  $("#findingTabs").innerHTML = tabs.map((t) => `<button class="tab-button ${t === currentFindingTab ? "active" : ""}" data-tab="${escapeHtml(t)}">${escapeHtml(t)} (${openFor(t).length})</button>`).join("");
  $("#findingList").innerHTML = openFor(currentFindingTab).map((f) => findingCard(f, currentFindingTab)).join("");
}

/* ---- Evidence explorer ---- */
function populateEvidenceFilter() {
  const options = ['<option value="all">All evidence</option>'];
  Object.entries(currentProject.findings).forEach(([bucket, list]) => list.forEach((f) => options.push(`<option value="finding:${f.id}">${escapeHtml(bucket)}: ${escapeHtml(f.title.slice(0, 40))}</option>`)));
  [...new Set((currentProject.evidence || []).map((e) => e.agent))].forEach((agent) => options.push(`<option value="agent:${escapeHtml(agent)}">Agent: ${escapeHtml(agent)}</option>`));
  const sel = $("#evidenceFindingFilter");
  const prev = sel.value;
  sel.innerHTML = options.join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function renderEvidence() {
  if (!currentProject) return;
  populateEvidenceFilter();
  const minConf = Number($("#evidenceConfidenceFilter").value);
  $("#evidenceConfidenceValue").textContent = minConf;
  const sourceType = $("#evidenceSourceFilter").value;
  const filterVal = $("#evidenceFindingFilter").value;
  const filters = { minConfidence: minConf, sourceType };
  if (filterVal.startsWith("finding:")) filters.findingId = filterVal.slice(8);
  if (filterVal.startsWith("agent:")) filters.agent = filterVal.slice(6);
  const results = window.DD.evidence.query(currentProject, filters);
  const avg = window.DD.evidence.averageConfidence(results);
  $("#evidenceAverageConfidence").textContent = `${avg}%`;
  $("#evidenceSummary").innerHTML = `<span class="chip">${results.length} facts</span><span class="chip">avg ${avg}% confidence</span><span class="chip">${new Set(results.map((r) => r.docName)).size} source documents</span>`;
  $("#evidenceList").innerHTML = results.map((e) => `
    <button class="evidence-item ${evidenceSelection === e.id ? "active" : ""}" data-evidence="${e.id}">
      <div class="evidence-item-top"><strong>${escapeHtml(e.fact)}</strong><span class="confidence">${e.confidence}%</span></div>
      <span class="muted">${escapeHtml(e.docName)}${e.page ? `, p.${e.page}` : ""} • ${escapeHtml(e.location)} • ${escapeHtml(e.agent)}</span>
    </button>`).join("") || `<p class="muted">No evidence matches these filters.</p>`;
  const selected = window.DD.evidence.byId(currentProject, evidenceSelection) || results[0];
  renderEvidenceDetail(selected);
}

function renderEvidenceDetail(e) {
  if (!e) { $("#evidenceDetail").innerHTML = `<p class="muted">Select an evidence item to view its source excerpt and citation.</p>`; return; }
  evidenceSelection = e.id;
  $("#evidenceDetail").innerHTML = `
    <div class="panel-head"><div><span class="eyebrow">Citation</span><h2>${escapeHtml(e.docName)}</h2></div><span class="confidence">${e.confidence}%</span></div>
    <div class="citation-meta">
      <span><b>Page</b> ${e.page ?? "—"}</span><span><b>Location</b> ${escapeHtml(e.location)}</span>
      <span><b>Agent</b> ${escapeHtml(e.agent)}</span><span><b>Logged</b> ${new Date(e.createdAt).toLocaleString()}</span>
    </div>
    <p class="fact"><b>Fact:</b> ${escapeHtml(e.fact)}</p>
    <blockquote class="excerpt">${escapeHtml(e.excerpt || "No excerpt captured.")}</blockquote>`;
}

/* ---- Missing / Risks / Memo / Reports ---- */
function renderMissing() {
  const coverage = window.DD.classify.coverage(currentProject.documents || [], currentProject.type);
  const missing = coverage.filter((c) => c.count === 0);
  const cards = [];
  missing.forEach((c) => cards.push(["Missing category", `No ${c.category} documents uploaded for a ${currentProject.type} workflow.`, "Critical"]));
  (currentProject.recommendation?.unresolved || []).forEach((u) => cards.push(["Unresolved item", u, "High"]));
  Object.values(currentProject.findings).flat().filter((f) => f.status === "Needs Review").slice(0, 6)
    .forEach((f) => cards.push(["Awaiting review", f.title, f.severity]));
  $("#missingGrid").innerHTML = cards.length ? cards.map(([tag, text, sev]) => `
    <article class="missing-card">
      <span class="status-badge ${sev === "Critical" ? "danger" : sev === "High" ? "warning" : "info"}">${escapeHtml(sev)}</span>
      <h2>${escapeHtml(tag)}</h2><p class="muted">${escapeHtml(text)}</p>
    </article>`).join("") : `<p class="muted">No outstanding gaps detected.</p>`;
}

function renderRisks() {
  const reg = currentProject.riskRegister;
  $("#riskProfile").innerHTML = reg ? `<p><strong>Overall profile:</strong> ${escapeHtml(reg.overallProfile || "")} <span class="muted">(${reg.source} engine)</span></p>` : `<p class="muted">Run the Risk Assessment Agent to build the register.</p>`;
  const grouped = currentProject.risks && Object.keys(currentProject.risks).length ? currentProject.risks : { Critical: [], High: [], Medium: [], Low: [] };
  $("#riskColumns").innerHTML = ["Critical", "High", "Medium", "Low"].map((severity) => `
    <section class="risk-column">
      <h2 class="severity-${severity.toLowerCase()}">${severity} (${(grouped[severity] || []).length})</h2>
      ${(grouped[severity] || []).map((item) => `
        <article class="risk-card"><strong>${escapeHtml(item[0])}</strong><p>${escapeHtml(item[1])}</p>
        <div class="finding-meta"><span>${escapeHtml(item[2])}</span><span>${escapeHtml(item[3])}</span></div></article>`).join("") || `<p class="muted">None.</p>`}
    </section>`).join("");
}

function renderMemo() {
  const sections = currentProject.memoSectionsMeta || ["Executive Summary", "Investment Thesis", "Financial Analysis", "Legal Analysis", "Commercial Analysis", "Operational Analysis", "Key Risks", "Recommendation"];
  $("#memoNav").innerHTML = sections.map((s, i) => `<button class="${i === 0 ? "secondary-button" : "ghost-button"}" data-memo-jump="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("");
  const body = $("#memoBody");
  if (body.dataset.projectId !== currentProject.id) { body.innerHTML = currentProject.memoHtml; body.dataset.projectId = currentProject.id; }
  const rec = currentProject.recommendation;
  $("#recommendationBanner").innerHTML = rec ? `
    <div class="rec-pill rec-${rec.decision.replace(/\s+/g, "-").toLowerCase()}">
      <div><span class="eyebrow">Recommendation (${rec.source} engine)</span><strong>${escapeHtml(rec.decision)}</strong></div>
      <div class="rec-meta"><span>${rec.confidence}% confidence</span><span>${escapeHtml(rec.rationale || "")}</span></div>
    </div>` : `<p class="muted">Run the Recommendation Agent to generate a decision.</p>`;
}

function renderReports() {
  $("#reportsGrid").innerHTML = [
    ["Full PDF Report", "Findings, risk register, and evidence appendix.", "file-down", "exportPdf", "PDF"],
    ["Investment Committee Memo", "Editable memo with recommendation and citations.", "file-text", "exportWord", "Word"],
    ["Diligence Workbook", "Findings, risks, evidence, and financial metrics.", "table", "exportExcel", "Excel"],
    ["Board Presentation", "Summary slides with findings and risk tables.", "presentation", "exportPptx", "PowerPoint"]
  ].map(([title, desc, ic, fn, badge]) => `
    <article class="report-card">
      <div>${icon(ic)}<h2>${escapeHtml(title)}</h2><p class="muted">${escapeHtml(desc)}</p></div>
      <div class="finding-card-top"><span>${badge}</span><button class="primary-button" data-export="${fn}">${icon("download")}Export</button></div>
    </article>`).join("");
}

function renderSettings() {
  const cfg = window.DD.llm.getConfig();
  $("#llmProvider").value = cfg.provider;
  $("#llmModel").value = cfg.provider === "openai" ? cfg.openaiModel : cfg.claudeModel;
  $("#llmApiKey").value = cfg.apiKey || "";
  $("#llmStatus").textContent = window.DD.llm.isConfigured() ? "Configured" : "Not configured";
  $("#llmStatus").className = `status-badge ${window.DD.llm.isConfigured() ? "success" : "info"}`;
}

function renderEmptyWorkspace() {
  document.querySelectorAll("#dashboard .metric-card").forEach((card) => {
    card.querySelector("strong").textContent = "0";
    card.querySelector("small").textContent = "Create a project to begin";
  });
  const muted = (msg) => `<p class="muted">${msg}</p>`;
  $("#projectTable").innerHTML = muted('No projects yet. Click “New Project” to create your first diligence workspace.');
  $("#agentStack").innerHTML = muted("No active deal.");
  $("#notifications").innerHTML = muted("No activity yet.");
  $("#recentReports").innerHTML = "";
  $("#projectKanban").innerHTML = muted("No projects yet.");
  $("#projectSwitcher").innerHTML = `<option>No projects</option>`;
  $("#sidebarProjectName").textContent = "No project selected";
  $("#sidebarProjectMeta").textContent = "Create a project to begin.";
  $("#sidebarProjectProgress").style.width = "0%";
  $("#fileTable").innerHTML = muted("Create a project, then upload documents.");
  $("#coverageList").innerHTML = ""; $("#missingInline").innerHTML = "";
  $("#processingSummary").textContent = "0 documents";
  $("#agentGrid").innerHTML = muted("Create a project to run agents.");
  $("#findingTabs").innerHTML = ""; $("#findingList").innerHTML = muted("No findings.");
  $("#researchGrid").innerHTML = muted("Create a project first.");
  $("#evidenceList").innerHTML = muted("No evidence."); $("#evidenceSummary").innerHTML = "";
  $("#evidenceDetail").innerHTML = muted("No project selected.");
  $("#missingGrid").innerHTML = muted("No project selected.");
  $("#riskColumns").innerHTML = ""; $("#riskProfile").innerHTML = muted("No project selected.");
  $("#reportsGrid").innerHTML = muted("Create a project to export reports.");
  $("#recommendationBanner").innerHTML = ""; $("#memoNav").innerHTML = "";
  const body = $("#memoBody"); body.innerHTML = muted("Create a project to draft a memo."); body.dataset.projectId = "";
  $("#financialMetricGrid").innerHTML = muted("No project selected.");
  renderSettings();
}

function renderProjectSurfaces() {
  if (!currentProject) { renderEmptyWorkspace(); refreshIcons(); return; }
  renderDashboard();
  renderSidebar();
  renderProjectsPage();
  renderDataRoom();
  renderAnalysis();
  renderFindings();
  renderEvidence();
  renderMissing();
  renderRisks();
  renderMemo();
  renderReports();
  renderSettings();
  refreshIcons();
}

function renderAll() {
  initNav();
  renderProjectSurfaces();
}

/* --------------------------------------------------------------- review UI */
function openReview(findingId, bucket, kind) {
  const { finding } = window.DD.review.findFinding(currentProject, findingId);
  if (!finding) return;
  reviewTarget = { findingId, bucket, kind };
  $("#reviewModalKind").textContent = kind === "History" ? "Review history" : kind === "Edited" ? "Edit finding" : "Comment on finding";
  $("#reviewModalTitle").textContent = finding.title;
  $("#reviewEditFields").style.display = kind === "Edited" ? "grid" : "none";
  $("#reviewTitle").value = finding.title;
  $("#reviewSummary").value = finding.summary;
  $("#reviewSeverity").value = finding.severity;
  $("#reviewConfidence").value = finding.confidence;
  $("#reviewNote").value = "";
  $("#reviewSave").style.display = kind === "History" ? "none" : "inline-flex";
  const hist = window.DD.review.history(currentProject, findingId);
  $("#reviewHistory").innerHTML = (hist.versions.length || hist.reviews.length)
    ? hist.versions.map((v) => `<div class="history-row"><span class="status-badge info">${escapeHtml(v.action)}</span><span>${escapeHtml(v.by)} • ${new Date(v.at).toLocaleString()} • was "${escapeHtml(v.before.title)}" (${v.before.severity}, ${v.before.confidence}%, ${escapeHtml(v.before.status)})</span></div>`).join("")
    : `<p class="muted">No prior versions. Actions you take will appear here.</p>`;
  $("#reviewModal").showModal();
  refreshIcons();
}

async function saveReview() {
  if (!reviewTarget) return;
  const { findingId, kind } = reviewTarget;
  const opts = { user: currentUser.name, note: $("#reviewNote").value.trim() };
  if (kind === "Edited") {
    opts.edits = { title: $("#reviewTitle").value.trim(), summary: $("#reviewSummary").value.trim(), severity: $("#reviewSeverity").value, confidence: $("#reviewConfidence").value };
  }
  window.DD.review.act(currentProject, findingId, kind, opts);
  await saveCurrentProject(`Finding ${kind.toLowerCase()} by ${currentUser.name}`);
  renderProjectSurfaces();
  showToast(`Finding ${kind.toLowerCase()}. Version recorded.`);
}

async function quickReview(findingId, action) {
  window.DD.review.act(currentProject, findingId, action, { user: currentUser.name });
  await saveCurrentProject(`Finding ${action.toLowerCase()} by ${currentUser.name}`);
  renderProjectSurfaces();
  showToast(`Finding ${action.toLowerCase()}.`);
}

/* --------------------------------------------------------------- exports */
function doExport(fn) {
  if (!requireProject()) return;
  try {
    window.DD.exporter[fn](currentProject);
    showToast(`${fn.replace("export", "")} export generated.`);
  } catch (error) {
    console.error(error);
    showToast(`Export failed: ${error.message}`);
  }
}

/* --------------------------------------------------------------- wiring */
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll("[data-auth-mode]").forEach((b) => b.classList.toggle("active", b.dataset.authMode === mode));
  $("#nameField").style.display = mode === "signup" ? "grid" : "none";
  $("#authSubmit").innerHTML = mode === "signup" ? `${icon("user-plus")}Create account` : `${icon("log-in")}Log in`;
  $("[name='password']").autocomplete = mode === "signup" ? "new-password" : "current-password";
  refreshIcons();
}

async function openProject(projectId) {
  const body = $("#memoBody");
  if (currentProject && body.dataset.projectId === currentProject.id) currentProject.memoHtml = body.innerHTML;
  await saveCurrentProject("Autosaved before switching projects");
  currentProject = projects.find((p) => p.id === projectId) || currentProject;
  renderProjectSurfaces();
  showToast(`${currentProject.name} reopened.`);
}

async function deleteProject(projectId) {
  const project = projects.find((p) => p.id === projectId);
  if (!project) return;
  if (!window.confirm(`Delete "${project.name}"? This deletes its findings, evidence, and uploaded documents. This cannot be undone.`)) return;

  const deletingCurrent = currentProject && currentProject.id === projectId;
  // Cancel any pending debounced save so it can't write a stale copy back after delete.
  if (deletingCurrent) window.clearTimeout(saveTimer);

  // Remove the project record itself.
  await window.DD.store.del("projects", projectId);
  // Remove its orphaned document blobs (stored separately, keyed by document id).
  await Promise.all((project.documents || []).map((doc) => window.DD.store.del("docblobs", doc.id).catch(() => {})));

  projects = projects.filter((p) => p.id !== projectId);

  if (deletingCurrent) {
    // Switching context — clear per-project view state so the Findings Center,
    // evidence explorer, and review modal don't reference the deleted project.
    currentProject = projects[0] || null;
    currentFindingTab = null;
    evidenceSelection = null;
    reviewTarget = null;
  }
  renderProjectSurfaces();
  showToast(`${project.name} deleted — findings and documents removed.`);
}

function wireInteractions() {
  document.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-target]"); if (nav) showPage(nav.dataset.target);
    const openP = event.target.closest("[data-open-project]"); if (openP) openProject(openP.dataset.openProject);
    const delP = event.target.closest("[data-delete-project]"); if (delP) deleteProject(delP.dataset.deleteProject);
    const tab = event.target.closest("[data-tab]"); if (tab) { currentFindingTab = tab.dataset.tab; renderFindings(); refreshIcons(); }
    const quick = event.target.closest("[data-quick]"); if (quick) quickReview(quick.dataset.finding, quick.dataset.quick);
    const rev = event.target.closest("[data-review]"); if (rev) openReview(rev.dataset.finding, rev.dataset.bucket, rev.dataset.review);
    const evFor = event.target.closest("[data-evidence-for]"); if (evFor) { $("#evidenceFindingFilter").value = `finding:${evFor.dataset.evidenceFor}`; $("#evidenceConfidenceFilter").value = 0; showPage("evidence"); renderEvidence(); }
    const evItem = event.target.closest("[data-evidence]"); if (evItem) { renderEvidenceDetail(window.DD.evidence.byId(currentProject, evItem.dataset.evidence)); renderEvidence(); }
    const exp = event.target.closest("[data-export]"); if (exp) doExport(exp.dataset.export);
  });

  $("#authTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-auth-mode]"); if (b) setAuthMode(b.dataset.authMode); });
  $("#configureGoogle").addEventListener("click", promptForGoogleClientId);
  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    try {
      const user = authMode === "signup" ? await createAccount(formData) : await login(formData);
      await setSession(user);
      showToast(authMode === "signup" ? "Account created and projects seeded." : "Logged in.");
    } catch (error) { showToast(error.message); }
  });

  $("#newProjectBtn").addEventListener("click", () => $("#projectModal").showModal());
  $("#newProjectBtnSecondary").addEventListener("click", () => $("#projectModal").showModal());
  $("#logoutBtn").addEventListener("click", async () => {
    await saveCurrentProject("Saved before logout");
    localStorage.removeItem(SESSION_KEY);
    currentUser = null; currentProject = null; projects = [];
    // Stop Google from silently re-selecting the same account on the auth screen.
    if (googleReady()) { try { window.google.accounts.id.disableAutoSelect(); } catch { /* ignore */ } }
    $("#appShell").classList.add("locked");
    $("#authScreen").classList.remove("hidden");
    initGoogleSignIn();
    showToast("Logged out.");
  });

  $("#saveProjectBtn").addEventListener("click", async () => {
    if (!requireProject()) return;
    const body = $("#memoBody");
    if (body.dataset.projectId === currentProject.id) currentProject.memoHtml = body.innerHTML;
    await saveCurrentProject("Manual save");
    showToast("Project saved.");
  });
  $("#projectSwitcher").addEventListener("change", (e) => { if (currentProject) openProject(e.target.value); });
  $("#themeToggle").addEventListener("click", () => {
    document.body.classList.toggle("dark");
    showToast(document.body.classList.contains("dark") ? "Dark mode enabled" : "Light mode enabled");
  });

  $("#createProject").addEventListener("click", async (event) => {
    const form = $("#projectForm");
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const dealType = data.get("dealType");
    const typeMap = { VC: "Venture Capital", PE: "Private Equity", "M&A": "M&A" };
    const project = newProjectRecord({
      company: data.get("company"), industry: data.get("industry"), type: typeMap[dealType] || dealType,
      team: data.get("team"), value: data.get("value"), close: data.get("close")
    }, currentUser.id, { dealType });
    await window.DD.store.put("projects", project);
    await loadProjects(project.id);
    $("#projectModal").close(); form.reset();
    renderProjectSurfaces(); showPage("data-room");
    showToast("Project created. Data Room ready — upload documents to begin.");
  });

  // ---- Data Room upload ----
  const uploadZone = $("#uploadZone");
  const input = $("#documentInput");
  const folderInput = $("#folderInput");
  $("#uploadDocuments").addEventListener("click", () => input.click());
  $("#browseDocuments").addEventListener("click", () => input.click());
  $("#browseFolder").addEventListener("click", () => folderInput.click());
  input.addEventListener("change", (e) => { handleUpload(e.target.files); e.target.value = ""; });
  folderInput.addEventListener("change", (e) => { handleUpload(e.target.files); e.target.value = ""; });
  ["dragenter", "dragover"].forEach((n) => uploadZone.addEventListener(n, (e) => { e.preventDefault(); uploadZone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((n) => uploadZone.addEventListener(n, async (e) => {
    e.preventDefault(); uploadZone.classList.remove("dragging");
    if (n !== "drop") return;
    // Support dropping whole folders (recursively) as well as individual files.
    const files = await filesFromDataTransfer(e.dataTransfer);
    handleUpload(files);
  }));
  $("#dataRoomSearch").addEventListener("input", renderDataRoom);
  $("#categoryFilter").addEventListener("change", renderDataRoom);
  $("#clearDataRoomSearch").addEventListener("click", () => { $("#dataRoomSearch").value = ""; $("#categoryFilter").value = "all"; renderDataRoom(); });

  // ---- Orchestrator ----
  $("#runOrchestrator").addEventListener("click", runOrchestrator);

  // ---- Financial ----
  $("#financialStatementInput").addEventListener("input", (e) => { if (!currentProject) return; currentProject.financialInput = e.target.value; scheduleSave("Financial input edited"); });
  $("#loadSampleFinancials").addEventListener("click", () => {
    if (!requireProject()) return;
    currentProject.financialInput = "Metric, FY2023, FY2024, FY2025\nRevenue, 82, 118, 145\nCOGS, 33, 45, 54\nGross Profit, 49, 73, 91\nEBITDA, 9, 17, 26\nNet Income, 2, 7, 13\nCash, 14, 19, 22\nDebt, 30, 34, 40\nCurrent Assets, 40, 52, 63\nCurrent Liabilities, 22, 26, 29";
    $("#financialStatementInput").value = currentProject.financialInput;
    scheduleSave("Sample financials loaded"); showToast("Sample financials loaded. Run analysis.");
  });
  $("#financialFileInput").addEventListener("change", async (e) => {
    if (!requireProject()) return;
    const file = e.target.files[0]; if (!file) return;
    const result = await window.DD.extract.extract(file);
    currentProject.financialInput = result.fullText;
    $("#financialStatementInput").value = result.fullText;
    scheduleSave("Financial file loaded"); showToast("Financial file parsed. Run analysis.");
  });

  // ---- Evidence ----
  ["change", "input"].forEach((evt) => {
    $("#evidenceFindingFilter").addEventListener(evt, renderEvidence);
    $("#evidenceConfidenceFilter").addEventListener(evt, renderEvidence);
    $("#evidenceSourceFilter").addEventListener(evt, renderEvidence);
  });
  $("#copyEvidenceApi").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(window.DD.evidence.API_CONTRACT); showToast("Evidence API contract copied."); }
    catch { showToast("Copy failed — see console."); console.log(window.DD.evidence.API_CONTRACT); }
  });
  $("#exportEvidenceBundle").addEventListener("click", () => {
    if (!requireProject()) return;
    const blob = new Blob([JSON.stringify(currentProject.evidence || [], null, 2)], { type: "application/json" });
    window.DD.exporter.download(blob, `${currentProject.name.replace(/\s+/g, "-").toLowerCase()}-evidence.json`);
    showToast("Evidence bundle exported as JSON.");
  });

  // ---- Review modal ----
  $("#reviewSave").addEventListener("click", (e) => { e.preventDefault(); saveReview(); $("#reviewModal").close(); });

  // ---- Memo / Reports ----
  // Stay on the memo page so its loading bar is visible while the orchestrator runs.
  $("#generateMemo").addEventListener("click", () => { runOrchestrator(); });
  $("#exportMemoPdf").addEventListener("click", () => doExport("exportPdf"));
  $("#exportMemoWord").addEventListener("click", () => doExport("exportWord"));
  $("#memoBody").addEventListener("input", (e) => { if (!currentProject) return; currentProject.memoHtml = e.currentTarget.innerHTML; scheduleSave("Memo edited"); });

  // ---- Settings ----
  $("#llmProvider").addEventListener("change", (e) => { const cfg = window.DD.llm.getConfig(); $("#llmModel").value = e.target.value === "openai" ? cfg.openaiModel : cfg.claudeModel; });
  $("#saveLlmConfig").addEventListener("click", () => {
    const provider = $("#llmProvider").value;
    const patch = { provider, apiKey: $("#llmApiKey").value.trim() };
    if (provider === "openai") patch.openaiModel = $("#llmModel").value.trim() || "gpt-4o";
    else patch.claudeModel = $("#llmModel").value.trim() || "claude-opus-4-8";
    window.DD.llm.setConfig(patch);
    renderSettings(); if (currentProject) renderAnalysis(); refreshIcons();
    showToast(patch.apiKey ? "AI engine configured — orchestrator will use the live model." : "Key cleared — orchestrator uses the heuristic engine.");
  });

  $("#testLlmConfig").addEventListener("click", async () => {
    const btn = $("#testLlmConfig");
    const result = $("#llmTestResult");
    const provider = $("#llmProvider").value;
    const apiKey = $("#llmApiKey").value.trim();
    if (!apiKey) {
      result.hidden = false;
      result.className = "llm-test-result error";
      result.textContent = "Enter an API key first, then test.";
      return;
    }
    // Test the values currently in the form (may differ from what's saved).
    const override = { provider, apiKey };
    if (provider === "openai") override.openaiModel = $("#llmModel").value.trim() || "gpt-4o";
    else override.claudeModel = $("#llmModel").value.trim() || "claude-opus-4-8";

    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader"></i>Testing…';
    refreshIcons();
    result.hidden = false;
    result.className = "llm-test-result pending";
    result.textContent = "Contacting the provider…";
    try {
      const res = await window.DD.llm.testConnection(override);
      result.className = `llm-test-result ${res.ok ? "success" : "error"}`;
      result.textContent = `${res.ok ? "✓ " : "✕ "}${res.message}`;
    } catch (err) {
      result.className = "llm-test-result error";
      result.textContent = `✕ Test failed: ${err.message}`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
      refreshIcons();
    }
  });

  $("#clearAllProjects").addEventListener("click", async () => {
    if (!projects.length) { showToast("No projects to delete."); return; }
    if (!window.confirm(`Delete all ${projects.length} project(s)? This cannot be undone.`)) return;
    await Promise.all(projects.map((p) => window.DD.store.del("projects", p.id)));
    projects = []; currentProject = null;
    renderProjectSurfaces();
    showPage("dashboard");
    showToast("All projects deleted. Workspace is now empty.");
  });

  $("#globalSearch").addEventListener("input", (e) => { const v = e.target.value.trim(); if (v.length > 2) { $("#dataRoomSearch").value = v; renderDataRoom(); } });
}

async function init() {
  if (!("indexedDB" in window)) { showToast("This browser does not support IndexedDB."); return; }
  await window.DD.db.open();
  initNav();
  wireInteractions();
  setAuthMode("login");
  await restoreSession();
  // Set up Google sign-in. GIS loads async; hook its load callback and also try now.
  window.onGoogleLibraryLoad = initGoogleSignIn;
  initGoogleSignIn();
  refreshIcons();
}

init().catch((error) => { console.error(error); showToast("Could not initialize the local database."); });

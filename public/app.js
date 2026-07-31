/* Sentinel DD — UI orchestration layer.
 * Delegates document processing, agents, review, and export to the js/ modules.
 * Data + auth now live server-side behind window.DD.api (Cloudflare Worker). */
const { cryptoId, clone, escapeHtml } = window.DD.util;

const navItems = [
  ["dashboard", "Dashboard", "layout-dashboard"],
  ["projects", "Projects", "briefcase-business"],
  ["data-room", "Data Room", "database"],
  ["analysis", "Analysis", "activity"],
  ["analysis-workspace", "Analysis Workspace", "list-checks"],
  ["memo", "Investment Memo", "file-pen-line"],
  ["intelligence", "Deal Intelligence", "brain-circuit"],
  ["reports", "Reports", "download"],
  ["settings", "Settings", "settings"]
];

let currentUser = null;
let authMode = "login";
let projects = [];
let currentProject = null;
let currentFindingTab = null;
let currentWorkspaceTab = "findings-pane";
let saveTimer = null;
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

// Turns a rejected promise into a visible toast instead of a silent, unhandled
// failure — used to wrap fire-and-forget async calls from click handlers.
function reportError(prefix) {
  return (error) => { console.error(error); showToast(`${prefix}: ${error.message || "unknown error"}`); };
}

function requireProject() {
  if (!currentProject) { showToast("Create a project first."); return false; }
  return true;
}

/* ------------------------------------------------------------------ auth */
// Auth now runs entirely server-side (Cloudflare Worker + D1). The browser holds
// no password logic and no session token — the server sets an HttpOnly cookie.
async function createAccount(formData) {
  const { user } = await window.DD.api.auth.signup(
    String(formData.get("email")).trim(),
    String(formData.get("password")),
    String(formData.get("name") || "").trim()
  );
  return user;
}

async function login(formData) {
  const { user } = await window.DD.api.auth.login(
    String(formData.get("email")).trim(),
    String(formData.get("password"))
  );
  return user;
}

async function setSession(user) {
  currentUser = user;
  await window.DD.llm.refreshStatus();
  await loadProjects();
  $("#authScreen").classList.add("hidden");
  $("#appShell").classList.remove("locked");
  $("#userLabel").textContent = user.name;
  renderAll();
}

// Restore an existing session by asking the server who the cookie belongs to.
async function restoreSession() {
  try {
    const { user } = await window.DD.api.auth.me();
    if (user) await setSession(user);
  } catch { /* not signed in / backend unreachable — stay on the auth screen */ }
}

/* ------------------------------------------------------ Google sign-in (GIS) */
const GOOGLE_CLIENT_ID_KEY = "sentinel-dd-google-client-id";
// The developer sets the Client ID once in config.js; localStorage is only a
// quick-testing override. config.js wins so the button "just works" for everyone.
function getGoogleClientId() {
  const fromConfig = ((window.SENTINEL_CONFIG && window.SENTINEL_CONFIG.googleClientId) || "").trim();
  return fromConfig || (localStorage.getItem(GOOGLE_CLIENT_ID_KEY) || "").trim();
}
let googleSignInInitialized = false;
let googleSignInSucceeded = false;
function setGoogleClientId(id) { localStorage.setItem(GOOGLE_CLIENT_ID_KEY, (id || "").trim()); }
function googleRunnableOrigin() { return window.location.protocol === "http:" || window.location.protocol === "https:"; }

// The raw Google ID token is sent to the server, which verifies its signature,
// expiry, and audience before creating/linking the account. No client-side decode.
async function handleGoogleCredential(response) {
  if (googleSignInSucceeded) return;
  try {
    if (!response || !response.credential) {
      if (currentUser) return;
      throw new Error("No credential returned by Google.");
    }
    const { user } = await window.DD.api.auth.google(response.credential);
    try {
      await setSession(user);
      googleSignInSucceeded = true;
      showToast(`Signed in as ${user.name} via Google.`);
    } catch (renderError) {
      googleSignInSucceeded = true;
      console.error("Google sign-in succeeded but page render failed", renderError);
      showToast(`Signed in as ${user.name} via Google. Reload the page if the UI looks wrong.`);
    }
  } catch (error) {
    console.error(error);
    showToast(`Google sign-in failed: ${error.message}`);
  }
}

function googleReady() { return Boolean(window.google && window.google.accounts && window.google.accounts.id); }

// Render the official Google button when everything is in place; otherwise show a
// single clear message about what's missing. No pop-up prompts in the normal flow.
function initGoogleSignIn() {
  googleSignInSucceeded = false;
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
  if (!slot) {
    console.warn("Google sign-in slot is missing; skipping button rendering.");
    if (hint) hint.textContent = "Google sign-in is unavailable because the button container is missing.";
    return;
  }
  try {
    if (!googleSignInInitialized) {
      window.google.accounts.id.initialize({ client_id: clientId, callback: handleGoogleCredential, auto_select: false });
      googleSignInInitialized = true;
    }
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
    findings: overrides.findings || {},
    research: overrides.research || null,
    financial: overrides.financial || null,
    crossValidation: overrides.crossValidation || null,
    riskRegister: overrides.riskRegister || null,
    risks: overrides.risks || {},
    recommendation: overrides.recommendation || null,
    financialInput: overrides.financialInput || "",
    memoHtml: overrides.memoHtml || "<h2>Executive Summary</h2><p>Upload documents and run the AI agents to draft this memorandum.</p>",
    agentRuns: overrides.agentRuns || {},
    reviewLog: overrides.reviewLog || [],
    auditLog: overrides.auditLog || [{ at: now, action: "Project created" }]
  };
}

async function loadProjects(preferredId) {
  const { projects: list } = await window.DD.api.projects.list();
  projects = list || [];
  projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  currentProject = projects.find((p) => p.id === preferredId) || projects[0] || null;
}

async function saveCurrentProject(reason = "Project saved") {
  if (!currentProject) return;
  currentProject.updatedAt = new Date().toISOString();
  currentProject.auditLog = currentProject.auditLog || [];
  currentProject.auditLog.unshift({ at: currentProject.updatedAt, action: reason });
  currentProject.auditLog = currentProject.auditLog.slice(0, 20);
  const { project } = await window.DD.api.projects.save(currentProject.id, currentProject);
  const idx = projects.findIndex((p) => p.id === currentProject.id);
  if (idx >= 0) projects[idx] = project || currentProject;
}

function scheduleSave(reason) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveCurrentProject(reason).catch(reportError("Autosave failed — your last edit may not be saved")), 400);
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

// The Analysis Workspace page bundles Findings/Missing/Risks behind an
// internal sub-tab bar so they no longer need separate sidebar entries or page navigations.
function showWorkspaceTab(paneId) {
  currentWorkspaceTab = paneId;
  document.querySelectorAll(".workspace-pane").forEach((pane) => pane.classList.toggle("active", pane.dataset.pane === paneId));
  document.querySelectorAll("#workspaceTabs [data-subtab]").forEach((btn) => btn.classList.toggle("active", btn.dataset.subtab === paneId));
}

function countFindings(project, predicate) {
  return Object.values(project.findings || {}).flat().filter(predicate || (() => true)).length;
}

// Doesn't depend on currentProject — the AI key is configured server-side per account.
function renderHealthPill() {
  const pill = $("#dashboardHealthPill");
  const aiConfigured = window.DD.llm.isConfigured();
  pill.className = `health-pill ${aiConfigured ? "" : "danger"}`.trim();
  pill.innerHTML = `<span></span>${aiConfigured ? "OpenAI configured" : "No AI key configured — analysis unavailable"}`;
}

function renderDashboard() {
  renderHealthPill();
  const cards = document.querySelectorAll("#dashboard .metric-card");
  const totalDocs = projects.reduce((s, p) => s + (p.documents?.length || 0), 0);
  const totalFindings = projects.reduce((s, p) => s + countFindings(p), 0);
  const openFindings = projects.reduce((s, p) => s + countFindings(p, (f) => f.status !== "Approved" && f.status !== "Rejected"), 0);
  const values = [
    [projects.length, "Saved diligence projects"],
    [totalDocs, "Documents processed"],
    [totalFindings, "Findings logged"],
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
  const cats = ["all", ...window.DD.classify.categories, "Uncategorized"];
  const filter = $("#categoryFilter");
  const currentCat = filter.value || "all";
  filter.innerHTML = cats.map((c) => `<option value="${c}" ${c === currentCat ? "selected" : ""}>${c === "all" ? "All categories" : c}</option>`).join("");

  const rows = window.DD.dataroom.inventory(project, { search: $("#dataRoomSearch").value, category: filter.value });
  $("#processingSummary").textContent = `${project.documents?.length || 0} documents`;
  $("#fileTable").innerHTML = rows.length ? rows.map((doc) => `
    <div class="file-row">
      <div><div class="row-title">${escapeHtml(doc.name)}</div><div class="row-sub">${doc.pageCount || 0} pages • ${doc.wordCount || 0} words${doc.ocrUsed ? " • OCR" : ""} • ${new Date(doc.uploadedAt).toLocaleString()}</div></div>
      <span>${escapeHtml(doc.category)}<br><small class="muted">${escapeHtml(doc.docType)}</small></span>
      <span class="status-badge ${doc.status === "Duplicate" ? "warning" : doc.status === "Error" ? "danger" : "success"}">${escapeHtml(doc.status)}</span>
      <span class="muted">${escapeHtml(doc.duplicate)}</span>
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
  const ready = window.DD.llm.isConfigured();
  $("#analysisProviderBadge").textContent = ready ? "OpenAI" : "Not configured";
  $("#analysisProviderBadge").className = `status-badge ${ready ? "success" : "danger"}`;

  const agents = Object.entries(window.DD.agents.REGISTRY);
  const progress = agents.map(([key, a]) => {
    const done = Boolean(runs[key]);
    return `<div class="agent-run-item">
      <div class="agent-run-top"><strong>${escapeHtml(a.name)}</strong><span class="status-badge ${done ? "success" : "info"}">${done ? "✓" : "—"}</span></div>
      <div class="progress-track"><span style="width:${done ? 100 : 0}%"></span></div>
    </div>`;
  }).join("");

  let summary;
  if (!allRun) {
    summary = ready
      ? `<p>Run the analysis to orchestrate all ${agents.length} specialist agents through your documents.</p>`
      : `<p class="inline-error">No OpenAI key is configured on the server — analysis cannot run until one is set (see Settings).</p>`;
  } else {
    summary = `<p><strong>Analysis complete.</strong> All ${agents.length} agents ran on OpenAI.</p>`;
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
  if (!window.DD.llm.isConfigured()) { showToast("No OpenAI key configured on the server — analysis can't run. See Settings."); return; }
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
    await window.DD.agents.runAll(currentProject, onStep);
    // Show the completed 100% state briefly before the final summary replaces it.
    renderOrchestratorLive(total, total, "");
    setMemoProgress({ pct: 100, label: "Memo ready", sub: "Analysis complete." });
    await paintYield(300);
    currentProject.agentRuns.__orchestrator = { at: new Date().toISOString() };
    currentProject.progress = 96;
    currentProject.status = "IC Memo";
    await saveCurrentProject("Orchestrator analysis complete");
    renderProjectSurfaces();
    // Leave "Memo ready" visible briefly, then fade the memo loading bar out.
    window.setTimeout(() => setMemoProgress({ show: false }), 1200);
    showToast("Analysis complete. Review findings, risks, and memo.");
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

// Re-runs just the Risk and Recommendation agents against the findings already on
// hand — for when a reviewer edits/approves findings and wants the register and
// decision to reflect that without re-running the full 9-agent orchestrator.
async function rebuildRiskRegister() {
  if (!requireProject()) return;
  if (!Object.values(currentProject.findings || {}).flat().length) {
    showToast("Run the analysis first — the risk register is built from findings.");
    return;
  }
  const btn = $("#runRiskAgent");
  btn.disabled = true;
  showToast("Rebuilding risk register…");
  try {
    await window.DD.agents.run(currentProject, "risk-agent");
    await window.DD.agents.run(currentProject, "recommendation-agent");
    await saveCurrentProject("Risk register rebuilt");
    renderProjectSurfaces();
    showToast("Risk register rebuilt.");
  } catch (error) {
    reportError("Couldn't rebuild risk register")(error);
  } finally {
    btn.disabled = false;
  }
}

/* ---- Financial page ---- */
function renderFinancial() {
  const fin = currentProject.financial;
  $("#financialStatementInput").value = currentProject.financialInput || "";
  $("#financialSourceBadge").textContent = fin ? "AI-generated" : "No data";
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
}

/* ---- Research page ---- */
function renderResearch() {
  const r = currentProject.research;
  if (!r) { $("#researchGrid").innerHTML = `<p class="muted">Run the analysis to gather company overview, competitors, executives, news, patents, filings, and market data.</p>`; return; }
  const list = (title, items, render) => `<article class="panel"><div class="panel-head"><div><span class="eyebrow">${title}</span></div></div>${items && items.length ? items.map(render).join("") : `<p class="muted">None found.</p>`}</article>`;
  $("#researchGrid").innerHTML = `
    <article class="panel span-2"><div class="panel-head"><div><span class="eyebrow">Overview</span><h2>${escapeHtml(currentProject.name)}</h2></div><span class="status-badge info">${escapeHtml(r.industry || "")}</span></div>
      <p>${escapeHtml(r.overview || "")}</p><p class="muted">${escapeHtml(r.businessModel || "")}</p></article>
    ${list("Competitors", r.competitors, (c) => `<div class="research-row"><strong>${escapeHtml(c.name)}</strong><span>${escapeHtml(c.note || "")}</span></div>`)}
    ${list("Executives", r.executives, (e) => `<div class="research-row"><strong>${escapeHtml(e.name)}</strong><span>${escapeHtml(e.role || "")}</span></div>`)}
    ${list("News", r.news, (n) => `<div class="research-row"><strong>${escapeHtml(n.headline)}</strong><span>${escapeHtml(n.summary || "")} ${escapeHtml(n.date || "")}</span></div>`)}
    ${list("Patents", r.patents, (p) => `<div class="research-row"><strong>${escapeHtml(p.title || p.note || "Patent")}</strong><span>${escapeHtml(p.note || "")}</span></div>`)}
    ${list("Regulatory filings", r.filings, (f) => `<div class="research-row"><strong>${escapeHtml(f.type || "Filing")}</strong><span>${escapeHtml(f.note || "")}</span></div>`)}
    <article class="panel"><div class="panel-head"><div><span class="eyebrow">Market</span></div></div><p><strong>Size:</strong> ${escapeHtml(r.market?.size || "—")} • <strong>Growth:</strong> ${escapeHtml(r.market?.growth || "—")}</p><p class="muted">${escapeHtml(r.market?.notes || "")}</p></article>
    <article class="panel span-2"><div class="panel-head"><div><span class="eyebrow">Claims &amp; self-reported confidence</span></div></div>
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
      <span class="status-badge ${statusClass}">${escapeHtml(f.status)}</span>
      <span>${escapeHtml(f.agent || "")}</span>
    </div>
    <div class="finding-actions">
      <button class="secondary-button" data-finding="${f.id}" data-bucket="${escapeHtml(bucket)}" data-quick="Approved">${icon("check")}Approve</button>
      <button class="secondary-button" data-finding="${f.id}" data-bucket="${escapeHtml(bucket)}" data-quick="Rejected">${icon("x")}Reject</button>
      <button class="secondary-button" data-finding="${f.id}" data-bucket="${escapeHtml(bucket)}" data-review="Edited">${icon("pencil")}Edit</button>
      <button class="secondary-button" data-finding="${f.id}" data-bucket="${escapeHtml(bucket)}" data-review="Commented">${icon("message-square")}Comment</button>
      <button class="ghost-button" data-finding="${f.id}" data-bucket="${escapeHtml(bucket)}" data-review="History">${icon("history")}History</button>
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

/* ---- Risks / Memo / Reports ---- */
function renderRisks() {
  const reg = currentProject.riskRegister;
  $("#riskProfile").innerHTML = reg ? `<p><strong>Overall profile:</strong> ${escapeHtml(reg.overallProfile || "")}</p>` : `<p class="muted">Run the Risk Assessment Agent to build the register.</p>`;
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
  if (body.dataset.projectId !== currentProject.id) { body.innerHTML = window.DD.util.sanitizeMemoHtml(currentProject.memoHtml); body.dataset.projectId = currentProject.id; }
  const rec = currentProject.recommendation;
  $("#recommendationBanner").innerHTML = rec ? `
    <div class="rec-pill rec-${rec.decision.replace(/\s+/g, "-").toLowerCase()}">
      <div><span class="eyebrow">Recommendation</span><strong>${escapeHtml(rec.decision)}</strong></div>
      <div class="rec-meta"><span>${rec.confidence}% confidence</span>${rec.learning ? `<span>📈 Informed by ${rec.learning.comparables} comparable past deal(s)</span>` : ""}<span>${escapeHtml(rec.rationale || "")}</span></div>
    </div>
    <p class="disclaimer-note"><i data-lucide="alert-triangle"></i>AI-generated, not investment advice. A qualified human must independently verify this analysis before any capital is committed.</p>` : `<p class="muted">Run the Recommendation Agent to generate a decision.</p>`;
  refreshIcons();
}

function renderReports() {
  $("#reportsGrid").innerHTML = [
    ["Full PDF Report", "Findings and risk register.", "file-down", "exportPdf", "PDF"],
    ["Investment Committee Memo", "Editable memo with recommendation.", "file-text", "exportWord", "Word"],
    ["Diligence Workbook", "Findings, risks, and financial metrics.", "table", "exportExcel", "Excel"],
    ["Board Presentation", "Summary slides with findings and risk tables.", "presentation", "exportPptx", "PowerPoint"]
  ].map(([title, desc, ic, fn, badge]) => `
    <article class="report-card">
      <div>${icon(ic)}<h2>${escapeHtml(title)}</h2><p class="muted">${escapeHtml(desc)}</p></div>
      <div class="finding-card-top"><span>${badge}</span><button class="primary-button" data-export="${fn}">${icon("download")}Export</button></div>
    </article>`).join("");
}

function renderSettings() {
  const cfg = window.DD.llm.getConfig();
  $("#llmModel").value = cfg.model;
  const ready = window.DD.llm.isConfigured();
  $("#llmStatus").textContent = ready ? "Server AI ready" : "Not configured — analysis will fail";
  $("#llmStatus").className = `status-badge ${ready ? "success" : "danger"}`;
}

/* ---- Deal Intelligence / Post-Deal Learning ---- */
async function renderIntelligence() {
  if (!currentProject || !window.DD.learning) return;
  const L = window.DD.learning;
  const pct = (v) => `${Math.round(v * 100)}%`;

  // 1) Comparable past deals for the current project (scored server-side).
  const cmp = $("#comparableDeals");
  const { comparableDeals, signal } = await L.contextFor(currentProject);
  if (!comparableDeals.length) {
    cmp.innerHTML = `<p class="muted">No comparable past deals in the learning bank yet. As finalized outcomes are contributed, deals similar to this one (by type, industry, size, and risk profile) appear here and are fed to the agents.</p>`;
  } else {
    const chips = [`<span class="chip">${comparableDeals.length} matches</span>`];
    if (signal?.avgSuccess != null) chips.push(`<span class="chip">avg success ${signal.avgSuccess.toFixed(1)}/5</span>`);
    if (signal?.closedRate != null) chips.push(`<span class="chip">${pct(signal.closedRate)} closed</span>`);
    if (signal?.commonMissedRisks?.length) chips.push(`<span class="chip danger">commonly missed: ${escapeHtml(signal.commonMissedRisks.slice(0, 3).join(", "))}</span>`);
    cmp.innerHTML = `<div class="chip-row">${chips.join("")}</div>` + comparableDeals.map((d) => `
      <div class="file-row">
        <div><div class="row-title">${escapeHtml(d.industry)} • ${escapeHtml(d.dealType)}</div>
          <div class="row-sub">${escapeHtml(d.valueBand)} • prior call: ${escapeHtml(d.priorRecommendation || "—")} • ${d.outcome.materializedRisks.length} risk(s) materialized / ${d.outcome.missedRisks.length} missed</div></div>
        <span class="status-badge ${d.outcome.closed ? "success" : "warning"}">${d.outcome.closed ? "Closed" : "Not closed"}</span>
        <span>${d.outcome.successRating != null ? `${d.outcome.successRating}/5` : "—"}</span>
        <strong>${d.similarity}% match</strong>
      </div>`).join("");
  }

  // 2) Learning bank aggregate stats.
  const stats = await L.stats();
  $("#learningStats").innerHTML = [
    [stats.total, "Outcomes contributed"],
    [stats.avgSuccess != null ? `${stats.avgSuccess.toFixed(1)}/5` : "—", "Avg investment success"],
    [stats.closedRate != null ? pct(stats.closedRate) : "—", "Deals closed"],
    [Object.keys(stats.byType || {}).length, "Deal types represented"]
  ].map(([v, l]) => `<article class="metric-card"><span>${escapeHtml(l)}</span><strong>${escapeHtml(String(v))}</strong><small></small></article>`).join("");

  // 3) Your own contributions (delete-able). Other tenants' outcomes are never
  //    listed individually — only surfaced anonymized under Comparable Deals.
  const bank = await L.mine();
  $("#outcomeList").innerHTML = bank.length ? bank.map((r) => `
    <div class="file-row">
      <div><div class="row-title">${escapeHtml(r.industry)} • ${escapeHtml(r.dealType)} • ${escapeHtml(r.valueBand)}</div>
        <div class="row-sub">${r.outcome.closed ? "Closed" : "Not closed"}${r.outcome.finalPrice ? ` • ${escapeHtml(r.outcome.finalPrice)}` : ""} • success ${r.outcome.successRating ?? "—"}/5 • ${new Date(r.createdAt).toLocaleDateString()}</div></div>
      <span class="muted">${(r.outcome.missedRisks || []).length} missed</span>
      <button class="secondary-button" data-delete-outcome="${r.id}" title="Remove your contribution" style="color:var(--danger);">${icon("trash-2")}</button>
    </div>`).join("") : `<p class="muted">You haven't contributed any outcomes yet. Record a finalized deal's outcome above to start building proprietary intelligence.</p>`;

  // 4) Reset the form when switching projects; flag if this deal already has a record.
  const form = $("#outcomeForm");
  if (form && form.dataset.projectId !== currentProject.id) {
    form.reset();
    form.dataset.projectId = currentProject.id;
    const status = $("#outcomeStatus");
    const existing = await L.forProjectRecord(currentProject.id);
    if (existing) { status.hidden = false; status.textContent = "An outcome is already recorded for this deal."; }
    else { status.hidden = true; }
  }
  refreshIcons();
}

async function submitOutcome(form) {
  if (!requireProject()) return;
  const fd = new FormData(form);
  if (fd.get("consent") !== "on") { showToast("Please confirm you have permission before contributing this outcome."); return; }
  try {
    await window.DD.learning.record(currentProject, {
      consent: true,
      closed: fd.get("closed") === "yes",
      finalPrice: fd.get("finalPrice"),
      materializedRisks: fd.get("materializedRisks"),
      missedRisks: fd.get("missedRisks"),
      successRating: fd.get("successRating"),
      notes: fd.get("notes")
    });
    form.reset();
    form.dataset.projectId = "";           // force the status line to refresh
    renderIntelligence();
    showToast("Outcome contributed. Future comparable deals will benefit from this lesson.");
  } catch (error) { showToast(error.message); }
}

async function deleteOutcome(id) {
  if (!window.confirm("Remove this contributed outcome from the learning bank? This cannot be undone.")) return;
  await window.DD.learning.remove(id);
  renderIntelligence();
  showToast("Outcome removed from the learning bank.");
}

function renderEmptyWorkspace() {
  renderHealthPill();
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
  $("#processingSummary").textContent = "0 documents";
  $("#agentGrid").innerHTML = muted("Create a project to run agents.");
  $("#findingTabs").innerHTML = ""; $("#findingList").innerHTML = muted("No findings.");
  $("#researchGrid").innerHTML = muted("Create a project first.");
  $("#riskColumns").innerHTML = ""; $("#riskProfile").innerHTML = muted("No project selected.");
  $("#reportsGrid").innerHTML = muted("Create a project to export reports.");
  $("#recommendationBanner").innerHTML = ""; $("#memoNav").innerHTML = "";
  const body = $("#memoBody"); body.innerHTML = muted("Create a project to draft a memo."); body.dataset.projectId = "";
  $("#financialMetricGrid").innerHTML = muted("No project selected.");
  $("#financialTrendTable").innerHTML = ""; $("#valuationPanel").innerHTML = "";
  $("#financialFindingsList").innerHTML = muted("No project selected.");
  $("#financialChecklist").innerHTML = ""; $("#financialStatementInput").value = "";
  $("#financialSourceBadge").textContent = "No data";
  $("#comparableDeals").innerHTML = muted("Create a project to see comparable past deals.");
  $("#learningStats").innerHTML = ""; $("#outcomeList").innerHTML = muted("No project selected.");
  renderSettings();
}

function renderProjectSurfaces() {
  if (!currentProject) { renderEmptyWorkspace(); refreshIcons(); return; }
  renderDashboard();
  renderSidebar();
  renderProjectsPage();
  renderDataRoom();
  renderAnalysis();
  renderFinancial();
  renderResearch();
  renderFindings();
  renderRisks();
  renderMemo();
  renderIntelligence();
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
  if (!window.confirm(`Delete "${project.name}"? This deletes its findings and uploaded documents. This cannot be undone.`)) return;

  const deletingCurrent = currentProject && currentProject.id === projectId;
  // Cancel any pending debounced save so it can't write a stale copy back after delete.
  if (deletingCurrent) window.clearTimeout(saveTimer);

  // The server deletes the project row and cascades its documents + R2 objects.
  try {
    await window.DD.api.projects.del(projectId);
  } catch (error) { showToast(`Delete failed: ${error.message}`); return; }

  projects = projects.filter((p) => p.id !== projectId);

  if (deletingCurrent) {
    // Switching context — clear per-project view state so the Findings Center
    // and review modal don't reference the deleted project.
    currentProject = projects[0] || null;
    currentFindingTab = null;
    reviewTarget = null;
  }
  renderProjectSurfaces();
  showToast(`${project.name} deleted — findings and documents removed.`);
}

function wireInteractions() {
  document.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-target]"); if (nav) {
      showPage(nav.dataset.target);
      if (nav.dataset.subtab) showWorkspaceTab(nav.dataset.subtab);
    }
    const subtab = event.target.closest("#workspaceTabs [data-subtab]"); if (subtab) showWorkspaceTab(subtab.dataset.subtab);
    const openP = event.target.closest("[data-open-project]"); if (openP) openProject(openP.dataset.openProject).catch(reportError("Couldn't open project"));
    const delP = event.target.closest("[data-delete-project]"); if (delP) deleteProject(delP.dataset.deleteProject).catch(reportError("Couldn't delete project"));
    const tab = event.target.closest("[data-tab]"); if (tab) { currentFindingTab = tab.dataset.tab; renderFindings(); refreshIcons(); }
    const quick = event.target.closest("[data-quick]"); if (quick) quickReview(quick.dataset.finding, quick.dataset.quick).catch(reportError("Couldn't save review"));
    const rev = event.target.closest("[data-review]"); if (rev) openReview(rev.dataset.finding, rev.dataset.bucket, rev.dataset.review);
    const exp = event.target.closest("[data-export]"); if (exp) doExport(exp.dataset.export);
    const delO = event.target.closest("[data-delete-outcome]"); if (delO) deleteOutcome(delO.dataset.deleteOutcome).catch(reportError("Couldn't delete outcome"));
  });

  $("#outcomeForm").addEventListener("submit", (e) => { e.preventDefault(); submitOutcome(e.currentTarget); });

  $("#authTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-auth-mode]"); if (b) setAuthMode(b.dataset.authMode); });
  $("#configureGoogle").addEventListener("click", promptForGoogleClientId);
  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    try {
      const user = authMode === "signup" ? await createAccount(formData) : await login(formData);
      await setSession(user);
      showToast(authMode === "signup" ? "Account created." : "Logged in.");
    } catch (error) { showToast(error.message); }
  });

  $("#newProjectBtn").addEventListener("click", () => $("#projectModal").showModal());
  $("#newProjectBtnSecondary").addEventListener("click", () => $("#projectModal").showModal());
  $("#logoutBtn").addEventListener("click", async () => {
    // Best-effort save — a failed autosave must never block logout itself.
    try { await saveCurrentProject("Saved before logout"); } catch (error) { console.error(error); }
    try { await window.DD.api.auth.logout(); } catch { /* clear locally regardless */ }
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
    try { await saveCurrentProject("Manual save"); showToast("Project saved."); }
    catch (error) { reportError("Save failed")(error); }
  });
  $("#projectSwitcher").addEventListener("change", (e) => { if (currentProject) openProject(e.target.value).catch(reportError("Couldn't switch project")); });
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
    const draft = newProjectRecord({
      company: data.get("company"), industry: data.get("industry"), type: typeMap[dealType] || dealType,
      team: data.get("team"), value: data.get("value"), close: data.get("close")
    }, currentUser.id, { dealType });
    try {
      const { project } = await window.DD.api.projects.create(draft);
      await loadProjects(project.id);
      $("#projectModal").close(); form.reset();
      renderProjectSurfaces(); showPage("data-room");
      showToast("Project created. Data Room ready — upload documents to begin.");
    } catch (error) { showToast(`Could not create project: ${error.message}`); }
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
  $("#runRiskAgent").addEventListener("click", rebuildRiskRegister);

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
    try {
      const result = await window.DD.extract.extract(file);
      currentProject.financialInput = result.fullText;
      $("#financialStatementInput").value = result.fullText;
      scheduleSave("Financial file loaded"); showToast("Financial file parsed. Run analysis.");
    } catch (error) { reportError("Couldn't parse financial file")(error); }
  });

  // ---- Review modal ----
  $("#reviewSave").addEventListener("click", async (e) => {
    e.preventDefault();
    try { await saveReview(); $("#reviewModal").close(); }
    catch (error) { reportError("Couldn't save review")(error); }
  });

  // ---- Memo / Reports ----
  // Stay on the memo page so its loading bar is visible while the orchestrator runs.
  $("#generateMemo").addEventListener("click", () => { runOrchestrator(); });
  $("#exportMemoPdf").addEventListener("click", () => doExport("exportPdf"));
  $("#exportMemoWord").addEventListener("click", () => doExport("exportWord"));
  $("#memoBody").addEventListener("input", (e) => { if (!currentProject) return; currentProject.memoHtml = window.DD.util.sanitizeMemoHtml(e.currentTarget.innerHTML); scheduleSave("Memo edited"); });

  // ---- Settings ----
  $("#saveLlmConfig").addEventListener("click", () => {
    window.DD.llm.setConfig({ model: $("#llmModel").value.trim() || "gpt-4o" });
    renderSettings(); if (currentProject) renderAnalysis(); refreshIcons();
    showToast("Model preference saved. The API key is managed on the server.");
  });

  $("#testLlmConfig").addEventListener("click", async () => {
    const btn = $("#testLlmConfig");
    const result = $("#llmTestResult");
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader"></i>Testing…';
    refreshIcons();
    result.hidden = false;
    result.className = "llm-test-result pending";
    result.textContent = "Asking the server to reach the model…";
    try {
      const res = await window.DD.llm.testConnection();
      result.className = `llm-test-result ${res.ok ? "success" : "error"}`;
      result.textContent = `${res.ok ? "✓ " : "✕ "}${res.message}`;
      renderSettings();
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
    await Promise.all(projects.map((p) => window.DD.api.projects.del(p.id).catch(() => {})));
    projects = []; currentProject = null;
    renderProjectSurfaces();
    showPage("dashboard");
    showToast("All projects deleted. Workspace is now empty.");
  });

  $("#globalSearch").addEventListener("input", (e) => { const v = e.target.value.trim(); if (v.length > 2) { $("#dataRoomSearch").value = v; renderDataRoom(); } });
}

async function init() {
  initNav();
  wireInteractions();
  setAuthMode("login");
  await restoreSession();
  // Set up Google sign-in. GIS loads async; hook its load callback and also try now.
  window.onGoogleLibraryLoad = initGoogleSignIn;
  initGoogleSignIn();
  refreshIcons();
}

init().catch((error) => { console.error(error); showToast("Could not start the app."); });

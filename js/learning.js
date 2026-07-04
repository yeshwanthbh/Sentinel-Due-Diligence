/* Sentinel DD — Proprietary Learning & Post-Deal Intelligence
 * ------------------------------------------------------------------
 * The platform improves over time by learning from finalized engagements.
 * After a deal closes, the user may OPTIONALLY submit its outcome. With
 * explicit consent, we store ONLY an anonymized, structured record — never
 * the original confidential documents, evidence excerpts, memo text, company
 * name, or team. Those never leave the project record.
 *
 * What is retained (structured, non-confidential):
 *   - industry, deal type, and deal-size band (for similarity matching)
 *   - a pre-close analysis snapshot: recommendation + risk-severity counts
 *   - the user-submitted outcome: closed?, final price, risks that
 *     materialized, risks that were missed, and a 1-5 success rating
 *
 * When analyzing a new company, DD.learning.contextFor(project) surfaces
 * comparable past deals + their outcomes, which are injected into the agent
 * context so recommendations become increasingly evidence-based. */
(function () {
  const DD = (window.DD = window.DD || {});
  const { cryptoId } = DD.util;
  const STORE = "outcomes";

  /* ---------------------------------------------------------- value bands */
  // Buckets keep the deal size useful for matching without over-fitting.
  const BANDS = ["<$25M", "$25M–$100M", "$100M–$500M", ">$500M", "Undisclosed"];

  // Parse "$185M", "1.2B", "40,000,000" → a number of USD (best-effort).
  function parseMoney(raw) {
    if (raw == null) return null;
    if (typeof raw === "number") return isFinite(raw) ? raw : null;
    const text = String(raw).trim().toLowerCase();
    if (!text) return null;
    const match = /(-?[\d,.]+)\s*(b|bn|billion|m|mm|million|k|thousand)?/.exec(text);
    if (!match) return null;
    const num = parseFloat(match[1].replace(/,/g, ""));
    if (!isFinite(num)) return null;
    const unit = match[2] || "";
    const mult = /^b/.test(unit) ? 1e9 : /^m/.test(unit) ? 1e6 : /^k|^t/.test(unit) ? 1e3 : 1;
    return num * mult;
  }

  function bandFor(raw) {
    const n = parseMoney(raw);
    if (n == null) return "Undisclosed";
    if (n < 25e6) return "<$25M";
    if (n < 100e6) return "$25M–$100M";
    if (n < 500e6) return "$100M–$500M";
    return ">$500M";
  }

  /* ---------------------------------------------------- analysis snapshot */
  // Structured, non-confidential picture of the pre-close analysis. No raw
  // finding titles or document text — only categories, severities, counts.
  function snapshotAnalysis(project) {
    const risks = (project.riskRegister && project.riskRegister.risks) || [];
    const riskCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    const categories = {};
    risks.forEach((r) => {
      if (riskCounts[r.severity] != null) riskCounts[r.severity] += 1;
      const cat = r.category || "Other";
      categories[cat] = Math.max(categories[cat] || 0, severityRank(r.severity));
    });
    const findings = Object.values(project.findings || {}).flat();
    const avgConfidence = findings.length
      ? Math.round(findings.reduce((s, f) => s + (f.confidence || 0), 0) / findings.length)
      : null;
    const rec = project.recommendation;
    return {
      recommendation: rec ? { decision: rec.decision, confidence: rec.confidence } : null,
      riskCounts,
      // e.g. { Financial: "High", Legal: "Medium" } — generic taxonomy, safe to share
      riskCategories: Object.entries(categories).map(([category, rank]) => ({ category, severity: rankSeverity(rank) })),
      findingCount: findings.length,
      evidenceCount: (project.evidence || []).length,
      avgConfidence
    };
  }

  function severityRank(s) { return { Critical: 4, High: 3, Medium: 2, Low: 1 }[s] || 0; }
  function rankSeverity(r) { return ["", "Low", "Medium", "High", "Critical"][r] || "Low"; }

  /* --------------------------------------------------------- record CRUD */
  // Build the anonymized record from a finalized project + user outcome form.
  // `outcome` = { closed, finalPrice, materializedRisks[], missedRisks[], successRating(1-5), notes }
  function buildRecord(project, outcome, ownerId) {
    const clean = (arr) => (Array.isArray(arr) ? arr : String(arr || "").split(/[\n,;]/))
      .map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
    return {
      id: cryptoId(),
      createdAt: new Date().toISOString(),
      // Provenance is kept ONLY so a contributor can find and delete their own
      // submission. It is never surfaced as identity when matching future deals.
      ownerId: ownerId || null,
      sourceProjectId: project.id || null,
      // --- non-confidential deal descriptors (no company name, no documents) ---
      industry: project.industry || "Unknown",
      dealType: project.dealType || "VC",
      valueBand: bandFor(outcome.finalPrice || project.value),
      // --- pre-close analysis snapshot ---
      analysis: snapshotAnalysis(project),
      // --- user-submitted outcome ---
      outcome: {
        closed: Boolean(outcome.closed),
        finalPrice: (outcome.finalPrice || "").toString().trim() || null,
        materializedRisks: clean(outcome.materializedRisks),
        missedRisks: clean(outcome.missedRisks),
        successRating: clampRating(outcome.successRating),
        notes: (outcome.notes || "").toString().trim().slice(0, 600) || null
      },
      consent: outcome.consent === true
    };
  }

  function clampRating(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return null;
    return Math.min(5, Math.max(1, n));
  }

  // Persist an outcome. Requires explicit consent — refuses otherwise so the
  // "only with customer permission" rule can't be bypassed by a caller.
  async function record(project, outcome, ownerId) {
    if (outcome.consent !== true) throw new Error("Consent is required to contribute a deal outcome to the learning bank.");
    const rec = buildRecord(project, outcome, ownerId);
    await DD.store.put(STORE, rec);
    return rec;
  }

  async function all() {
    try { return (await DD.store.getAll(STORE)) || []; }
    catch { return []; }
  }

  async function forProjectRecord(projectId) {
    const list = await all();
    return list.find((r) => r.sourceProjectId === projectId) || null;
  }

  async function remove(id) { return DD.store.del(STORE, id); }

  /* ----------------------------------------------------- similarity match */
  const STOP = new Set(["the", "and", "of", "for", "a", "an", "&", "inc", "llc", "corp", "co", "services", "solutions", "technologies", "technology", "group", "holdings"]);
  function tokens(text) {
    return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
  }

  function industryScore(a, b) {
    const ta = new Set(tokens(a));
    const tb = tokens(b);
    if (!ta.size || !tb.length) return 0;
    const overlap = tb.filter((w) => ta.has(w)).length;
    const union = new Set([...ta, ...tb]).size;
    return union ? overlap / union : 0; // Jaccard
  }

  function bandScore(a, b) {
    if (a === b) return 1;
    const ia = BANDS.indexOf(a); const ib = BANDS.indexOf(b);
    if (ia < 0 || ib < 0 || a === "Undisclosed" || b === "Undisclosed") return 0.25;
    return Math.abs(ia - ib) === 1 ? 0.5 : 0; // adjacent bands are partially similar
  }

  function riskProfileScore(a, b) {
    // cosine similarity over severity-count vectors
    const keys = ["Critical", "High", "Medium", "Low"];
    const va = keys.map((k) => (a && a[k]) || 0);
    const vb = keys.map((k) => (b && b[k]) || 0);
    const dot = va.reduce((s, x, i) => s + x * vb[i], 0);
    const ma = Math.sqrt(va.reduce((s, x) => s + x * x, 0));
    const mb = Math.sqrt(vb.reduce((s, x) => s + x * x, 0));
    return ma && mb ? dot / (ma * mb) : 0;
  }

  // Score a stored record against the current project. 0..1.
  function scoreAgainst(project, rec) {
    const w = { dealType: 0.35, industry: 0.35, band: 0.15, risk: 0.15 };
    const dealType = (rec.dealType === (project.dealType || "VC")) ? 1 : 0;
    const industry = industryScore(project.industry, rec.industry);
    const band = bandScore(bandFor(project.value), rec.valueBand);
    const risk = riskProfileScore(snapshotAnalysis(project).riskCounts, rec.analysis && rec.analysis.riskCounts);
    return w.dealType * dealType + w.industry * industry + w.band * band + w.risk * risk;
  }

  // Return comparable past deals for a project, most similar first.
  // Excludes the project's own previously-recorded outcome.
  async function similar(project, { limit = 5, threshold = 0.3 } = {}) {
    if (!project) return [];
    const list = await all();
    return list
      .filter((r) => r.consent && r.sourceProjectId !== project.id)
      .map((r) => ({ record: r, score: scoreAgainst(project, r) }))
      .filter((x) => x.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /* -------------------------------------------------- aggregate learning */
  // Roll comparable deals into a signal the agents (model + heuristic) can use.
  function summarize(matches) {
    const recs = matches.map((m) => m.record);
    const rated = recs.map((r) => r.outcome.successRating).filter((n) => n != null);
    const avgSuccess = rated.length ? rated.reduce((s, n) => s + n, 0) / rated.length : null;
    const closed = recs.filter((r) => r.outcome.closed).length;
    const tally = (getter) => {
      const counts = {};
      recs.forEach((r) => (getter(r) || []).forEach((t) => {
        const key = t.toLowerCase();
        counts[key] = counts[key] || { label: t, n: 0 };
        counts[key].n += 1;
      }));
      return Object.values(counts).sort((a, b) => b.n - a.n).map((c) => c.label);
    };
    return {
      count: recs.length,
      closedRate: recs.length ? closed / recs.length : null,
      avgSuccess,                                   // 1..5
      commonMaterializedRisks: tally((r) => r.outcome.materializedRisks).slice(0, 6),
      commonMissedRisks: tally((r) => r.outcome.missedRisks).slice(0, 6),
      poorTrackRecord: avgSuccess != null && recs.length >= 2 && avgSuccess <= 2.4,
      strongTrackRecord: avgSuccess != null && recs.length >= 2 && avgSuccess >= 4
    };
  }

  // Compact payload injected into the agent context (see agents.buildContext).
  // Async — agents await it when assembling context.
  async function contextFor(project) {
    const matches = await similar(project);
    if (!matches.length) return { comparableDeals: [], signal: null };
    const comparableDeals = matches.map(({ record: r, score }) => ({
      similarity: Math.round(score * 100),
      industry: r.industry,
      dealType: r.dealType,
      valueBand: r.valueBand,
      priorRecommendation: r.analysis && r.analysis.recommendation ? r.analysis.recommendation.decision : null,
      priorRiskCounts: r.analysis && r.analysis.riskCounts,
      outcome: {
        closed: r.outcome.closed,
        finalPrice: r.outcome.finalPrice,
        successRating: r.outcome.successRating,
        materializedRisks: r.outcome.materializedRisks,
        missedRisks: r.outcome.missedRisks
      }
    }));
    return { comparableDeals, signal: summarize(matches) };
  }

  /* -------------------------------------------------------- bank overview */
  async function stats() {
    const list = (await all()).filter((r) => r.consent);
    const byType = {};
    let ratedSum = 0; let rated = 0; let closed = 0;
    list.forEach((r) => {
      byType[r.dealType] = (byType[r.dealType] || 0) + 1;
      if (r.outcome.successRating != null) { ratedSum += r.outcome.successRating; rated += 1; }
      if (r.outcome.closed) closed += 1;
    });
    return {
      total: list.length,
      byType,
      avgSuccess: rated ? ratedSum / rated : null,
      closedRate: list.length ? closed / list.length : null
    };
  }

  DD.learning = {
    record, all, remove, forProjectRecord,
    similar, summarize, contextFor, stats,
    bandFor, parseMoney, BANDS
  };
})();

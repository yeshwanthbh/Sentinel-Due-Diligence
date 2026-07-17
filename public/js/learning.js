/* Sentinel DD — Proprietary Learning & Post-Deal Intelligence (client)
 * ------------------------------------------------------------------
 * The learning bank now lives server-side (worker/index.js) so outcomes are
 * shared across the whole customer base while staying anonymized. This module is
 * a thin client: it builds the anonymized, structured payload from a finalized
 * project and calls the API. Similarity scoring and cross-tenant anonymization
 * happen on the server — a browser never receives the full outcome table.
 *
 * What is contributed (with explicit consent): industry, deal type, deal-size
 * band, a pre-close analysis snapshot (recommendation + risk severity counts),
 * and the user-submitted result. Never the documents, evidence, memo, or company
 * name. */
(function () {
  const DD = (window.DD = window.DD || {});
  const api = () => DD.api.outcomes;

  /* ---------------------------------------------------- analysis snapshot */
  // Structured, non-confidential picture of the pre-close analysis. No raw
  // finding titles or document text — only categories, severities, counts.
  function snapshotAnalysis(project) {
    return {
      recommendation: project.recommendation
        ? { decision: project.recommendation.decision, confidence: project.recommendation.confidence }
        : null,
      riskCounts: riskCounts(project),
      riskCategories: riskCategories(project),
      findingCount: Object.values(project.findings || {}).flat().length,
      evidenceCount: (project.evidence || []).length
    };
  }

  function riskCounts(project) {
    const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    ((project.riskRegister && project.riskRegister.risks) || []).forEach((r) => {
      if (counts[r.severity] != null) counts[r.severity] += 1;
    });
    return counts;
  }

  function riskCategories(project) {
    const rank = { Critical: 4, High: 3, Medium: 2, Low: 1 };
    const names = ["", "Low", "Medium", "High", "Critical"];
    const map = {};
    ((project.riskRegister && project.riskRegister.risks) || []).forEach((r) => {
      const cat = r.category || "Other";
      map[cat] = Math.max(map[cat] || 0, rank[r.severity] || 0);
    });
    return Object.entries(map).map(([category, r]) => ({ category, severity: names[r] || "Low" }));
  }

  // Descriptor used to find comparable past deals for the CURRENT project.
  function descriptorFor(project) {
    return {
      industry: project.industry || "",
      dealType: project.dealType || "VC",
      value: project.value || "",
      riskCounts: riskCounts(project)
    };
  }

  /* -------------------------------------------------------------- API ops */
  // Contribute a finalized deal's outcome. Requires explicit consent.
  async function record(project, outcome) {
    if (outcome.consent !== true) throw new Error("Consent is required to contribute a deal outcome.");
    return api().record({
      sourceProjectId: project.id || null,
      industry: project.industry || "Unknown",
      dealType: project.dealType || "VC",
      value: outcome.finalPrice || project.value || "",
      analysis: snapshotAnalysis(project),
      outcome: {
        closed: Boolean(outcome.closed),
        finalPrice: outcome.finalPrice || null,
        materializedRisks: outcome.materializedRisks,
        missedRisks: outcome.missedRisks,
        successRating: outcome.successRating,
        notes: outcome.notes || null
      },
      consent: true
    });
  }

  // Comparable past deals + aggregate signal for a project. Shape:
  //   { comparableDeals: [...anonymized...], signal: {...} | null }
  // Consumed directly by agents.buildContext and the Deal Intelligence page.
  async function contextFor(project) {
    try {
      return await api().similar(descriptorFor(project));
    } catch (error) {
      console.warn("Learning context unavailable:", error.message);
      return { comparableDeals: [], signal: null };
    }
  }

  async function mine() {
    const { outcomes } = await api().mine();
    return outcomes || [];
  }

  async function forProjectRecord(projectId) {
    return (await mine()).find((r) => r.sourceProjectId === projectId) || null;
  }

  async function stats() { return api().stats(); }
  async function remove(id) { return api().del(id); }

  DD.learning = { record, contextFor, mine, forProjectRecord, stats, remove, snapshotAnalysis, descriptorFor };
})();

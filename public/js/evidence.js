/* Sentinel DD — Evidence & Citation Engine (Phase 4)
 * Every extracted fact links to: source document, page, location (paragraph/table/slide),
 * confidence score, and a supporting excerpt. Exposes a retrieval API every agent uses. */
(function () {
  const DD = (window.DD = window.DD || {});
  const { cryptoId } = DD.util;

  function ensure(project) {
    if (!project.evidence) project.evidence = [];
    return project.evidence;
  }

  // Locate a supporting excerpt for `term` inside a stored document's pages.
  function locate(doc, term) {
    if (!doc || !doc.pages) return null;
    const needle = String(term || "").toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    let best = null;
    doc.pages.forEach((pg) => {
      const text = pg.text || "";
      const lower = text.toLowerCase();
      let score = 0;
      needle.forEach((word) => { if (lower.includes(word)) score += 1; });
      if (score > (best?.score || 0)) {
        const first = needle.find((w) => lower.includes(w));
        const idx = first ? lower.indexOf(first) : 0;
        const excerpt = text.slice(Math.max(0, idx - 60), idx + 180).replace(/\s+/g, " ").trim();
        best = { score, page: pg.page, location: pg.unit || "page", excerpt: excerpt || text.slice(0, 200) };
      }
    });
    return best;
  }

  // Create + register an evidence item.
  function add(project, { docId, docName, fact, factKey, confidence, agent, findingId, page, location, excerpt }) {
    const list = ensure(project);
    const item = {
      id: cryptoId(),
      docId: docId || null,
      docName: docName || "Derived / external",
      fact,
      factKey: factKey || null,
      confidence: Math.max(1, Math.min(99, Math.round(confidence || 70))),
      agent: agent || "System",
      findingId: findingId || null,
      page: page ?? null,
      location: location || "paragraph",
      excerpt: excerpt || "",
      createdAt: new Date().toISOString()
    };
    list.push(item);
    return item;
  }

  // Convenience: build evidence by locating the fact inside a document.
  function cite(project, doc, { fact, factKey, confidence, agent, findingId }) {
    const hit = doc ? locate(doc, factKey || fact) : null;
    return add(project, {
      docId: doc?.id,
      docName: doc?.name,
      fact,
      factKey,
      confidence: confidence ?? (hit ? Math.min(96, 70 + hit.score * 5) : 62),
      agent,
      findingId,
      page: hit?.page ?? doc?.pages?.[0]?.page ?? null,
      location: hit?.location || doc?.pages?.[0]?.unit || "document",
      excerpt: hit?.excerpt || (doc?.textPreview || "").slice(0, 200)
    });
  }

  // ---- Retrieval API (used by every agent) ----
  function query(project, filters = {}) {
    const { agent, findingId, minConfidence = 0, sourceType = "all", text, docId } = filters;
    return ensure(project).filter((item) => {
      if (agent && item.agent !== agent) return false;
      if (findingId && item.findingId !== findingId) return false;
      if (docId && item.docId !== docId) return false;
      if (item.confidence < minConfidence) return false;
      if (sourceType !== "all") {
        const isTable = /table|sheet/.test(item.location);
        if (sourceType === "table" && !isTable) return false;
        if (sourceType === "paragraph" && isTable) return false;
      }
      if (text) {
        const q = text.toLowerCase();
        if (!(`${item.fact} ${item.excerpt} ${item.docName}`.toLowerCase().includes(q))) return false;
      }
      return true;
    });
  }

  function forFinding(project, findingId) {
    return query(project, { findingId });
  }

  function byId(project, id) {
    return ensure(project).find((item) => item.id === id) || null;
  }

  function averageConfidence(items) {
    if (!items.length) return 0;
    return Math.round(items.reduce((sum, item) => sum + item.confidence, 0) / items.length);
  }

  const API_CONTRACT = `// Evidence Engine — retrieval API (available to every agent)
DD.evidence.query(project, {
  agent,            // filter by producing agent, e.g. "Financial Due Diligence Agent"
  findingId,        // evidence supporting one finding
  docId,            // evidence sourced from one document
  minConfidence,    // 0-99
  sourceType,       // "all" | "table" | "paragraph"
  text              // free-text match against fact/excerpt/document
}) -> EvidenceItem[]

DD.evidence.forFinding(project, findingId) -> EvidenceItem[]
DD.evidence.cite(project, document, { fact, factKey, confidence, agent, findingId })

// EvidenceItem
{ id, docId, docName, fact, confidence, agent, findingId,
  page, location /* paragraph | table | slide | page */, excerpt, createdAt }`;

  DD.evidence = { add, cite, locate, query, forFinding, byId, averageConfidence, ensure, API_CONTRACT };
})();

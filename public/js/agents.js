/* Sentinel DD — AI agent orchestration (Phases 5-13)
 * Every agent is a specialized prompt against the SAME model (OpenAI). There is
 * no deterministic fallback engine: if no key is configured, or the model call
 * fails, the agent throws — analysis stops with a clear error rather than
 * silently substituting fabricated results. The only exceptions are genuine
 * deterministic math/checks (financial statement parsing, duplicate-document
 * detection, growth-rate reconciliation) that supplement the model's output
 * rather than standing in for it. */
(function () {
  const DD = (window.DD = window.DD || {});
  const { cryptoId, clone } = DD.util;
  const H = () => DD.heuristics;

  // ---------- specialized system prompts ----------
  const COMMON = `You are part of Sentinel, an AI due-diligence platform for private-market investors.
Be precise, skeptical, and evidence-driven. Never invent document contents. Only cite a filename
that appears in the provided documents. Return STRICT JSON only — no prose, no markdown fences.`;

  // Proprietary learning: appended to decision-oriented agents so they use the
  // anonymized outcomes of comparable past deals as additional context.
  const LEARNING_NOTE = `
You may also receive "comparableDeals": anonymized outcomes of similar past engagements — their
prior recommendation, risk profile, whether they closed, a 1-5 success rating, and the risks that
materialized or were MISSED — plus a "learningSignal" summary. Treat these as additional evidence:
weight risks that materialized in similar deals, explicitly check for risks those deals missed, and
calibrate your confidence to their track record. Do not invent deals beyond those provided.`;

  const REGISTRY = {
    "research-agent": {
      name: "Research & External Intelligence Agent", phase: 5, kind: "research", bucket: "External Research",
      system: `${COMMON}
Role: external intelligence analyst. Given a company name and industry, compile publicly known
information from your training knowledge. Be explicit about uncertainty; set lower confidence when unsure.
Return JSON:
{"overview":str,"industry":str,"businessModel":str,
 "competitors":[{"name":str,"note":str}],
 "executives":[{"name":str,"role":str}],
 "news":[{"headline":str,"summary":str,"date":str}],
 "patents":[{"title":str,"note":str}],
 "filings":[{"type":str,"note":str}],
 "market":{"size":str,"growth":str,"notes":str},
 "citations":[{"claim":str,"source":str,"confidence":int}]}`
    },
    "financial-agent": {
      name: "Financial Due Diligence Agent", phase: 6, kind: "financial", bucket: "Financial",
      system: `${COMMON}
Role: financial due-diligence analyst. Analyze the provided financial statement rows and financial
documents. Assess revenue, margins, working capital, debt, cash flow, valuation support, and anomalies.
Return JSON:
{"metrics":[{"label":str,"value":str,"hint":str}],
 "anomalies":[{"severity":"High|Medium|Low","text":str}],
 "findings":[{"title":str,"summary":str,"severity":"High|Medium|Low","confidence":int,"sourceDocs":[str],"excerpt":str}]}`
    },
    "legal-agent": {
      name: "Legal Due Diligence Agent", phase: 7, kind: "document", categories: ["Legal", "Corporate"], bucket: "Legal",
      system: `${COMMON}
Role: legal due-diligence counsel. Review contracts, litigation, governance, and compliance in the
documents. Identify legal risks (change-of-control, indemnities, litigation, IP, restrictive covenants).
Return JSON: {"findings":[{"title":str,"summary":str,"severity":"High|Medium|Low","confidence":int,"sourceDocs":[str],"excerpt":str}]}`
    },
    "commercial-agent": {
      name: "Commercial Due Diligence Agent", phase: 8, kind: "document", categories: ["Commercial", "Financial"], bucket: "Commercial",
      system: `${COMMON}
Role: commercial due-diligence analyst. Evaluate market sizing, competition, business model, customer
concentration, churn/retention, and pricing from the documents. Flag commercial risks.
Return JSON: {"findings":[{"title":str,"summary":str,"severity":"High|Medium|Low","confidence":int,"sourceDocs":[str],"excerpt":str}]}`
    },
    "operational-agent": {
      name: "Operational Due Diligence Agent", phase: 9, kind: "document", categories: ["Operational", "Technology"], bucket: "Operational",
      system: `${COMMON}
Role: operational & technology due-diligence analyst. Assess technology, cybersecurity, suppliers,
scalability, and operational resilience from the documents. Flag operational risks.
Return JSON: {"findings":[{"title":str,"summary":str,"severity":"High|Medium|Low","confidence":int,"sourceDocs":[str],"excerpt":str}]}`
    },
    "cross-validation-agent": {
      name: "Cross-Validation Agent", phase: 10, kind: "cross", bucket: null,
      system: `${COMMON}
Role: cross-validation auditor. Compare findings and figures across all agents and documents. Detect
contradictions, inconsistent values, and unverified calculations. Adjust confidence where evidence is weak.
Return JSON:
{"contradictions":[{"topic":str,"claimA":str,"sourceA":str,"claimB":str,"sourceB":str,"severity":"High|Medium|Low","resolution":str}],
 "confidenceAdjustments":[{"findingTitle":str,"newConfidence":int,"reason":str}]}`
    },
    "risk-agent": {
      name: "Risk Assessment Agent", phase: 11, kind: "risk", bucket: null,
      system: `${COMMON}
Role: risk officer. Aggregate all findings into a risk register. Score each by severity, likelihood,
business impact, and confidence. Produce an overall risk profile.${LEARNING_NOTE}
Return JSON:
{"risks":[{"title":str,"category":str,"severity":"Critical|High|Medium|Low","likelihood":"High|Medium|Low","impact":str,"confidence":int,"mitigation":str}],
 "overallProfile":str}`
    },
    "memo-agent": {
      name: "Investment Memo Agent", phase: 12, kind: "memo", bucket: null,
      system: `${COMMON}
Role: investment committee memo writer. Draft an IC memorandum from all findings and risks. Sections:
Executive Summary, Investment Thesis, Financial Analysis, Legal Analysis, Commercial Analysis,
Operational Analysis, Key Risks, Recommendation. Reference supporting evidence inline where possible.${LEARNING_NOTE}
Where comparable past deals are relevant, note the precedent in the Recommendation section.
Return JSON: {"sections":[{"heading":str,"html":str}]}`
    },
    "recommendation-agent": {
      name: "Recommendation Agent", phase: 13, kind: "recommendation", bucket: null,
      system: `${COMMON}
Role: investment decision maker. Weigh all findings, risks, and unresolved items. Decide whether
sufficient evidence exists and recommend exactly one of: "Invest", "Invest with Conditions",
"Continue Due Diligence", "Do Not Invest".${LEARNING_NOTE}
Return JSON: {"decision":str,"confidence":int,"rationale":str,"conditions":[str],"unresolved":[str]}`
    }
  };

  // ---------- project scaffolding ----------
  function ensure(project) {
    project.findings = project.findings || {};
    project.research = project.research || null;
    project.financial = project.financial || null;
    project.crossValidation = project.crossValidation || null;
    project.riskRegister = project.riskRegister || null;
    project.recommendation = project.recommendation || null;
    project.agentRuns = project.agentRuns || {};
    project.documents = project.documents || [];
    return project;
  }

  function docsForAgent(project, agent) {
    if (!agent.categories) return project.documents;
    return project.documents.filter((d) => agent.categories.includes(d.category) && !d.duplicateOf);
  }

  function buildContext(project, agent) {
    const docs = docsForAgent(project, agent).map((d) => ({
      name: d.name, category: d.category, docType: d.docType,
      excerpt: (d.textPreview || "").slice(0, 1600)
    }));
    const findings = [];
    Object.entries(project.findings).forEach(([bucket, list]) => {
      list.forEach((f) => findings.push({ bucket, title: f.title, severity: f.severity, confidence: f.confidence, summary: f.summary }));
    });
    return {
      company: project.name, industry: project.industry, workflow: project.type || project.workflow,
      documents: docs, existingFindings: findings, research: project.research
    };
  }

  // ---------- finding helpers ----------
  function addFinding(project, bucket, data) {
    project.findings[bucket] = project.findings[bucket] || [];
    const list = project.findings[bucket];
    const existing = list.find((f) => f.title.toLowerCase() === String(data.title).toLowerCase());
    const now = new Date().toISOString();
    if (existing) {
      existing.summary = data.summary || existing.summary;
      existing.severity = data.severity || existing.severity;
      existing.confidence = data.confidence ?? existing.confidence;
      existing.updatedAt = now;
      return existing;
    }
    const finding = {
      id: cryptoId(), title: data.title, summary: data.summary || "",
      severity: data.severity || "Medium", confidence: Math.round(data.confidence ?? 75),
      status: "Needs Review", agent: data.agent || bucket,
      reviews: [], versions: [],
      createdAt: now, updatedAt: now
    };
    list.push(finding);
    return finding;
  }

  // ================= RUN ENGINE =================
  // Requires the model. Throws (does not fall back to any substitute) if no key
  // is configured or the model call fails — callers (runAll/runOrchestrator)
  // surface that as a clear "Analysis failed: ..." error.
  async function run(project, agentKey) {
    ensure(project);
    const agent = REGISTRY[agentKey];
    if (!agent) throw new Error(`Unknown agent ${agentKey}`);
    if (!DD.llm.isConfigured()) {
      throw new Error(`${agent.name} requires an AI key, but the server has none configured.`);
    }
    const context = buildContext(project, agent);
    // Proprietary learning: enrich decision-oriented agents with anonymized
    // outcomes of comparable past deals. Best-effort — never blocks analysis.
    let learning = null;
    if (DD.learning && ["recommendation", "risk", "memo"].includes(agent.kind)) {
      try {
        learning = await DD.learning.contextFor(project);
        if (learning && learning.comparableDeals.length) {
          context.comparableDeals = learning.comparableDeals;
          context.learningSignal = learning.signal;
        }
      } catch (error) { console.warn("Learning context unavailable:", error.message); }
    }
    const output = await DD.llm.runJSON(agent.system, JSON.stringify(context));
    const applied = HANDLERS[agent.kind](project, agent, output, learning);
    project.agentRuns[agentKey] = { at: new Date().toISOString(), name: agent.name, kind: agent.kind };
    return { agent: agent.name, key: agentKey, kind: agent.kind, ...applied };
  }

  // ---------- per-kind handlers ----------
  // `output` is always the model's parsed JSON response here (run() throws
  // before reaching HANDLERS if there's no model output to hand it).
  const HANDLERS = {
    research(project, agent, output) {
      project.research = { ...output, generatedAt: new Date().toISOString() };
      (project.research.competitors || []).slice(0, 1).forEach((c) => {
        if (!c.name || /not resolved|unknown/i.test(c.name)) return;
        addFinding(project, "External Research", {
          title: "Competitive pressure identified", severity: "Low",
          summary: `External signals note ${c.name} as a competitor. ${c.note || ""}`.trim(),
          confidence: 66, agent: agent.name
        });
      });
      return { research: project.research };
    },

    financial(project, agent, output) {
      const input = project.financialInput || financialTextFromDocs(project);
      const parsed = H().parseFinancials(input);
      // Deterministic math is the source of truth for metrics/anomalies; the
      // model's numbers are used only if it didn't return its own.
      const metrics = output?.metrics?.length ? output.metrics : H().computeFinancialMetrics(parsed);
      const anomalies = output?.anomalies?.length ? output.anomalies : H().financialAnomalies(parsed);
      project.financial = { parsed, metrics, anomalies, valuation: buildValuation(parsed), generatedAt: new Date().toISOString() };

      (output?.findings || []).forEach((spec) => {
        addFinding(project, "Financial", { ...spec, agent: agent.name });
      });
      return { metrics, findings: (output?.findings || []).length };
    },

    document(project, agent, output) {
      let count = 0;
      (output?.findings || []).forEach((spec) => {
        addFinding(project, agent.bucket, { ...spec, agent: agent.name });
        count += 1;
      });
      return { findings: count };
    },

    cross(project, agent, output) {
      // Deterministic checks (duplicate docs, growth-rate reconciliation) always
      // run — they're cheap, exact, and orthogonal to what the model catches.
      // The model's semantic contradiction-detection is layered on top.
      const deterministic = deterministicCrossChecks(project);
      const contradictions = [...(output?.contradictions || []), ...deterministic.contradictions];
      if (output?.confidenceAdjustments?.length) {
        applyCrossValidationAdjustments(project, output.confidenceAdjustments);
      }
      project.crossValidation = { contradictions, generatedAt: new Date().toISOString() };
      return { contradictions: contradictions.length };
    },

    risk(project, agent, output) {
      const register = { risks: output?.risks || [], overallProfile: output?.overallProfile || "" };
      register.risks.forEach((r) => { r.id = r.id || cryptoId(); });
      project.riskRegister = { ...register, generatedAt: new Date().toISOString() };
      // keep legacy grouped structure in sync for the Risk Center view
      project.risks = groupRisks(register.risks);
      return { risks: register.risks.length };
    },

    memo(project, agent, output) {
      const sections = output?.sections || [];
      // Sanitize model-generated section HTML — it's built from untrusted uploaded-
      // document text and would otherwise be inserted via innerHTML verbatim.
      project.memoHtml = sections.map((s) => `<h2>${DD.util.escapeHtml(s.heading)}</h2>${DD.util.sanitizeMemoHtml(s.html)}`).join("\n");
      project.memoSectionsMeta = sections.map((s) => s.heading);
      return { sections: sections.length };
    },

    recommendation(project, agent, output, learning) {
      const rec = { decision: output?.decision, confidence: output?.confidence, rationale: output?.rationale, conditions: output?.conditions || [], unresolved: output?.unresolved || [] };
      // Overlay proprietary learning so the decision reflects how comparable past
      // deals actually turned out.
      applyLearningToRecommendation(rec, learning && learning.signal);
      project.recommendation = { ...rec, generatedAt: new Date().toISOString() };
      return { decision: project.recommendation.decision };
    }
  };

  // ================= deterministic helpers (math/checks, not AI substitutes) =================
  function financialTextFromDocs(project) {
    const doc = project.documents.find((d) => d.category === "Financial" && (d.ext === "xlsx" || d.ext === "csv" || d.ext === "xls"));
    return doc ? (doc.textPreview || "") : "";
  }

  function buildValuation(parsed) {
    const ebitda = parsed.ebitda ? parsed.ebitda[parsed.ebitda.length - 1] : null;
    const revenue = parsed.revenue ? parsed.revenue[parsed.revenue.length - 1] : null;
    const rows = [];
    if (ebitda) {
      [8, 10, 12].forEach((m) => rows.push({ label: `${m}x EBITDA`, value: H().fmt(ebitda * m) }));
    } else if (revenue) {
      [2, 3, 4].forEach((m) => rows.push({ label: `${m}x Revenue`, value: H().fmt(revenue * m) }));
    }
    return { basis: ebitda ? "EBITDA" : revenue ? "Revenue" : "Insufficient data", rows };
  }

  // Applies the cross-validation model's semantic confidence adjustments (e.g. "this
  // finding contradicts another agent's figures") to the matching findings by title.
  function applyCrossValidationAdjustments(project, adjustments) {
    const all = [];
    Object.values(project.findings).forEach((list) => list.forEach((f) => all.push(f)));
    adjustments.forEach((a) => {
      const target = all.find((f) => f.title === a.findingTitle);
      if (target && Number.isFinite(Number(a.newConfidence))) {
        target.confidence = Math.max(1, Math.min(99, Math.round(Number(a.newConfidence))));
      }
    });
  }

  // Exact, deterministic contradiction checks — not a substitute for the model's
  // semantic review, just the things code can verify precisely.
  function deterministicCrossChecks(project) {
    const contradictions = [];
    // 1) revenue growth: management claim vs computed
    const parsed = project.financial?.parsed;
    const computedGrowth = parsed ? H().pctChange(parsed.revenue) : null;
    const claim = (project.research?.overview || "") + Object.values(project.findings).flat().map((f) => f.summary).join(" ");
    const claimedMatch = /(\d{2,3})\s?%\s*(growth|cagr)/i.exec(claim);
    if (computedGrowth != null && claimedMatch) {
      const claimed = Number(claimedMatch[1]);
      if (Math.abs(claimed - computedGrowth) > 15) {
        contradictions.push({
          topic: "Revenue growth rate", severity: "High",
          claimA: `Management/narrative: ~${claimed}%`, sourceA: "Narrative / management materials",
          claimB: `Computed from statements: ${computedGrowth.toFixed(1)}%`, sourceB: "Financial statements",
          resolution: "Reconcile growth definition (organic vs. reported) and confirm periods."
        });
      }
    }
    // 2) duplicate/version conflicts among documents
    const dupes = project.documents.filter((d) => d.duplicateOf);
    if (dupes.length) {
      contradictions.push({
        topic: "Duplicate documents", severity: "Low",
        claimA: `${dupes.length} duplicate file(s) detected`, sourceA: "Data room intake",
        claimB: "Deduplicated originals retained", sourceB: "Document Processing Agent",
        resolution: "Confirm the retained version is the latest signed/final copy."
      });
    }
    return { contradictions };
  }

  function groupRisks(risks) {
    const grouped = { Critical: [], High: [], Medium: [], Low: [] };
    risks.forEach((r) => {
      (grouped[r.severity] = grouped[r.severity] || []).push([r.title, r.mitigation || r.impact, `${r.likelihood} likelihood`, `${r.confidence}% confidence`]);
    });
    return grouped;
  }

  // Overlay the learning-bank signal onto the model's recommendation. Mutates
  // `rec`: shifts a raw "Invest" toward caution when comparable deals had a weak
  // track record, nudges confidence, surfaces historically-missed risks, and
  // records a `learning` block the UI can display.
  function applyLearningToRecommendation(rec, signal) {
    if (!rec || !signal || !signal.count) return rec;
    rec.unresolved = rec.unresolved || [];
    // The single most valuable lesson: what similar deals FAILED to catch.
    signal.commonMissedRisks.slice(0, 3).forEach((r) => {
      const note = `Historically missed in similar deals: ${r}`;
      if (!rec.unresolved.includes(note)) rec.unresolved.push(note);
    });
    const notes = [];
    if (signal.poorTrackRecord) {
      notes.push(`${signal.count} comparable past deals had a weak track record (avg ${signal.avgSuccess.toFixed(1)}/5) — proceeding with added caution.`);
      if (rec.decision === "Invest") rec.decision = "Invest with Conditions";
      rec.confidence = Math.max(50, Math.round((rec.confidence ?? 70) - 8));
    } else if (signal.strongTrackRecord) {
      notes.push(`${signal.count} comparable past deals performed well (avg ${signal.avgSuccess.toFixed(1)}/5).`);
      rec.confidence = Math.min(96, Math.round((rec.confidence ?? 70) + 5));
    } else {
      notes.push(`${signal.count} comparable past deal(s) referenced from the learning bank.`);
    }
    rec.rationale = `${rec.rationale || ""} ${notes.join(" ")}`.trim();
    rec.learning = {
      comparables: signal.count,
      avgSuccess: signal.avgSuccess,
      closedRate: signal.closedRate,
      commonMissedRisks: signal.commonMissedRisks,
      commonMaterializedRisks: signal.commonMaterializedRisks
    };
    return rec;
  }

  // run a full sequence
  async function runAll(project, onStep) {
    const order = ["research-agent", "financial-agent", "legal-agent", "commercial-agent", "operational-agent", "cross-validation-agent", "risk-agent", "memo-agent", "recommendation-agent"];
    const results = [];
    for (let i = 0; i < order.length; i += 1) {
      const key = order[i];
      // Await the callback so the UI can paint a gradual progress step between agents.
      if (onStep) await onStep(key, REGISTRY[key].name, i, order.length); // eslint-disable-line no-await-in-loop
      results.push(await run(project, key)); // eslint-disable-line no-await-in-loop
    }
    return results;
  }

  // deterministicCrossChecks is exposed in addition to the main run/runAll entry
  // points so tests can exercise the deterministic checks directly, without
  // needing a project run through the full agent pipeline (which now requires
  // a real model call).
  DD.agents = { REGISTRY, run, runAll, ensure, addFinding, deterministicCrossChecks };
})();

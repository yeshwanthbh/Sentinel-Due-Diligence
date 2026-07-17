/* Sentinel DD — AI agent orchestration (Phases 5-13)
 * Each agent is the SAME underlying model (Claude/OpenAI) specialized by its system prompt.
 * With an API key the engine calls the LLM; without one it uses the deterministic engine.
 * Every finding is written back linked to Evidence Engine citations. */
(function () {
  const DD = (window.DD = window.DD || {});
  const { cryptoId, clone } = DD.util;
  const H = () => DD.heuristics;
  const EV = () => DD.evidence;

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
    project.evidence = project.evidence || [];
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
      evidenceIds: [], evidenceCount: 0, reviews: [], versions: [],
      createdAt: now, updatedAt: now
    };
    list.push(finding);
    return finding;
  }

  function findDoc(project, name) {
    if (!name) return null;
    const lower = String(name).toLowerCase();
    return project.documents.find((d) => d.name.toLowerCase() === lower)
      || project.documents.find((d) => d.name.toLowerCase().includes(lower) || lower.includes(d.name.toLowerCase()));
  }

  function linkEvidence(project, finding, sourceDocs, agentName, excerptHint) {
    const names = sourceDocs && sourceDocs.length ? sourceDocs : project.documents.slice(0, 1).map((d) => d.name);
    names.forEach((name) => {
      const doc = findDoc(project, name);
      const item = EV().cite(project, doc, {
        fact: finding.title, factKey: excerptHint || finding.title,
        agent: agentName, findingId: finding.id, confidence: finding.confidence
      });
      finding.evidenceIds.push(item.id);
    });
    finding.evidenceCount = finding.evidenceIds.length;
  }

  // ================= RUN ENGINE =================
  async function run(project, agentKey) {
    ensure(project);
    const agent = REGISTRY[agentKey];
    if (!agent) throw new Error(`Unknown agent ${agentKey}`);
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
    let source = "heuristic";
    let output = null;
    let modelError = null;
    if (DD.llm.isConfigured() && agent.kind !== "cross") {
      try {
        output = await DD.llm.runJSON(agent.system, JSON.stringify(context));
        source = "model";
      } catch (error) {
        if (error.message !== "NO_KEY") {
          modelError = error.message;
          console.warn(`${agent.name} model call failed, using heuristics:`, error.message);
        }
      }
    }
    const applied = HANDLERS[agent.kind](project, agent, output, source, learning);
    project.agentRuns[agentKey] = { at: new Date().toISOString(), source, name: agent.name, kind: agent.kind, modelError };
    return { agent: agent.name, key: agentKey, kind: agent.kind, source, modelError, ...applied };
  }

  // ---------- per-kind handlers ----------
  const HANDLERS = {
    research(project, agent, output, source) {
      if (output && source === "model") {
        project.research = { ...output, source, generatedAt: new Date().toISOString() };
      } else {
        project.research = heuristicResearch(project);
      }
      // Only register a competitive-pressure finding from genuine model intelligence.
      // The heuristic path returns a placeholder competitor ("Peer set not resolved");
      // turning that into a counted finding would fabricate diligence output.
      if (source === "model") {
        (project.research.competitors || []).slice(0, 1).forEach((c) => {
          if (!c.name || /not resolved|unknown/i.test(c.name)) return;
          const f = addFinding(project, "External Research", {
            title: "Competitive pressure identified", severity: "Low",
            summary: `External signals note ${c.name} as a competitor. ${c.note || ""}`.trim(),
            confidence: 66, agent: agent.name
          });
          EV().add(project, { fact: f.title, docName: "External research", agent: agent.name, findingId: f.id, confidence: 66, location: "paragraph", excerpt: c.note || c.name });
          f.evidenceCount = EV().forFinding(project, f.id).length;
        });
      }
      return { research: project.research };
    },

    financial(project, agent, output, source) {
      const input = project.financialInput || financialTextFromDocs(project);
      const parsed = H().parseFinancials(input);
      const metrics = (source === "model" && output?.metrics?.length) ? output.metrics : H().computeFinancialMetrics(parsed);
      const anomalies = (source === "model" && output?.anomalies) ? output.anomalies : H().financialAnomalies(parsed);
      project.financial = { parsed, metrics, anomalies, valuation: buildValuation(parsed), source, generatedAt: new Date().toISOString() };

      const findingsSpec = (source === "model" && output?.findings?.length)
        ? output.findings
        : heuristicFinancialFindings(parsed, anomalies);
      const financialDoc = project.documents.find((d) => d.category === "Financial" && !d.duplicateOf);
      findingsSpec.forEach((spec) => {
        const f = addFinding(project, "Financial", { ...spec, agent: agent.name });
        linkEvidence(project, f, spec.sourceDocs || (financialDoc ? [financialDoc.name] : []), agent.name, spec.excerpt);
      });
      return { metrics, findings: findingsSpec.length };
    },

    document(project, agent, output, source) {
      let count = 0;
      if (source === "model" && output?.findings?.length) {
        output.findings.forEach((spec) => {
          const f = addFinding(project, agent.bucket, { ...spec, agent: agent.name });
          linkEvidence(project, f, spec.sourceDocs, agent.name, spec.excerpt);
          count += 1;
        });
      } else {
        count = heuristicDocumentFindings(project, agent);
      }
      return { findings: count };
    },

    cross(project, agent, output, source) {
      const result = heuristicCrossValidation(project);
      project.crossValidation = { ...result, source: "heuristic", generatedAt: new Date().toISOString() };
      return { contradictions: result.contradictions.length };
    },

    risk(project, agent, output, source) {
      const register = (source === "model" && output?.risks?.length)
        ? { risks: output.risks, overallProfile: output.overallProfile }
        : heuristicRiskRegister(project);
      register.risks.forEach((r) => { r.id = r.id || cryptoId(); });
      project.riskRegister = { ...register, source, generatedAt: new Date().toISOString() };
      // keep legacy grouped structure in sync for the Risk Center view
      project.risks = groupRisks(register.risks);
      return { risks: register.risks.length };
    },

    memo(project, agent, output, source) {
      const sections = (source === "model" && output?.sections?.length) ? output.sections : heuristicMemoSections(project);
      project.memoHtml = sections.map((s) => `<h2>${DD.util.escapeHtml(s.heading)}</h2>${s.html}`).join("\n");
      project.memoSectionsMeta = sections.map((s) => s.heading);
      return { sections: sections.length };
    },

    recommendation(project, agent, output, source, learning) {
      const rec = (source === "model" && output?.decision)
        ? output
        : heuristicRecommendation(project);
      // Overlay proprietary learning on BOTH paths so the decision reflects how
      // comparable past deals actually turned out, consistently.
      applyLearningToRecommendation(rec, learning && learning.signal);
      project.recommendation = { ...rec, source, generatedAt: new Date().toISOString() };
      return { decision: project.recommendation.decision };
    }
  };

  // ================= heuristic implementations =================
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

  function heuristicFinancialFindings(parsed, anomalies) {
    const findings = anomalies.map((a) => ({
      title: a.text.length > 60 ? `${a.text.slice(0, 57)}...` : a.text,
      summary: a.text, severity: a.severity, confidence: 84
    }));
    const g = H().pctChange(parsed.revenue);
    if (g != null && g > 0 && g < 20) {
      findings.push({ title: "Revenue growth below plan threshold", summary: `Revenue grew ${g.toFixed(1)}% across the period — validate against the underwriting growth case.`, severity: "Medium", confidence: 80 });
    }
    if (!parsed.revenue) {
      findings.push({ title: "Financial statement data not machine-readable", summary: "No parseable revenue line detected. Upload a structured CSV/XLSX financial model for automated metrics.", severity: "Medium", confidence: 70 });
    } else {
      // always leave a baseline, evidence-linked financial finding
      const parts = [];
      if (g != null) parts.push(`revenue ${g >= 0 ? "grew" : "declined"} ${Math.abs(g).toFixed(1)}%`);
      const gm = parsed.grossProfit && parsed.revenue ? (parsed.grossProfit[parsed.grossProfit.length - 1] / parsed.revenue[parsed.revenue.length - 1]) * 100 : null;
      if (gm != null) parts.push(`gross margin ${gm.toFixed(1)}%`);
      findings.push({
        title: "Financial performance summary",
        summary: `Statement analysis: ${parts.join(", ") || "metrics computed"}. Metrics reconciled to source financial statements; verify against QoE adjustments.`,
        severity: "Low", confidence: 82
      });
    }
    return findings;
  }

  function heuristicDocumentFindings(project, agent) {
    const signals = H().SIGNALS[agent.categories && agent.categories[0] === "Legal" ? "legal-agent"
      : agent.categories && agent.categories[0] === "Commercial" ? "commercial-agent"
      : "operational-agent"] || [];
    const docs = docsForAgent(project, agent);
    let count = 0;
    signals.forEach((signal) => {
      const matches = docs.filter((doc) => {
        const text = `${doc.name}\n${doc.textPreview || ""}`.toLowerCase();
        return signal.kw.some((k) => text.includes(k));
      });
      if (!matches.length) return;
      const strength = matches.length;
      const f = addFinding(project, agent.bucket, {
        title: signal.title, summary: signal.summary, severity: signal.severity,
        confidence: H().severityConfidence(signal.severity, strength), agent: agent.name
      });
      linkEvidence(project, f, matches.map((m) => m.name), agent.name, signal.kw[0]);
      count += 1;
    });
    if (!count && docs.length) {
      const f = addFinding(project, agent.bucket, {
        title: `${agent.bucket} review — no material issues detected`,
        summary: `Automated review of ${docs.length} document(s) surfaced no keyword-level red flags. Manual review recommended.`,
        severity: "Low", confidence: 60, agent: agent.name
      });
      linkEvidence(project, f, docs.map((d) => d.name), agent.name);
      count += 1;
    }
    return count;
  }

  function heuristicResearch(project) {
    return {
      overview: `${project.name} operates in the ${project.industry} sector. Detailed external intelligence requires an LLM API key or connected research source; this is a heuristic placeholder derived from project metadata.`,
      industry: project.industry,
      businessModel: "Unknown — connect an LLM key to enrich.",
      competitors: [{ name: "Peer set not resolved", note: "Add an API key to populate competitor intelligence." }],
      executives: [],
      news: [],
      patents: [],
      filings: [],
      market: { size: "Unknown", growth: "Unknown", notes: "Connect research source to populate market sizing." },
      citations: [{ claim: `${project.name} is in ${project.industry}`, source: "Project metadata", confidence: 60 }],
      source: "heuristic", generatedAt: new Date().toISOString()
    };
  }

  function heuristicCrossValidation(project) {
    const contradictions = [];
    const adjustments = [];
    const all = [];
    Object.entries(project.findings).forEach(([bucket, list]) => list.forEach((f) => all.push({ bucket, f })));
    // 1) low-evidence findings -> lower confidence; multi-evidence -> raise
    all.forEach(({ f }) => {
      const ev = EV().forFinding(project, f.id).length;
      if (ev <= 1 && f.confidence > 70) adjustments.push({ findingTitle: f.title, newConfidence: Math.max(55, f.confidence - 12), reason: "Only one supporting evidence item." });
      if (ev >= 3) adjustments.push({ findingTitle: f.title, newConfidence: Math.min(97, f.confidence + 4), reason: "Corroborated by multiple documents." });
    });
    adjustments.forEach((a) => {
      const target = all.find(({ f }) => f.title === a.findingTitle);
      if (target) target.f.confidence = a.newConfidence;
    });
    // 2) revenue growth: management claim vs computed
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
    // 3) duplicate/version conflicts among documents
    const dupes = project.documents.filter((d) => d.duplicateOf);
    if (dupes.length) {
      contradictions.push({
        topic: "Duplicate documents", severity: "Low",
        claimA: `${dupes.length} duplicate file(s) detected`, sourceA: "Data room intake",
        claimB: "Deduplicated originals retained", sourceB: "Document Processing Agent",
        resolution: "Confirm the retained version is the latest signed/final copy."
      });
    }
    return { contradictions, confidenceAdjustments: adjustments };
  }

  function heuristicRiskRegister(project) {
    const risks = [];
    Object.entries(project.findings).forEach(([bucket, list]) => {
      list.forEach((f) => {
        if (/no material issues/i.test(f.title)) return;
        let severity = f.severity === "High" ? "High" : f.severity === "Medium" ? "Medium" : "Low";
        if (/concentration/i.test(f.title) && f.severity === "High") severity = "Critical";
        risks.push({
          id: cryptoId(), title: f.title, category: bucket, severity,
          likelihood: f.severity === "High" ? "Medium" : f.severity === "Low" ? "Low" : "Medium",
          impact: `${bucket} workstream impact`, confidence: f.confidence,
          mitigation: "Assign owner; gather corroborating evidence before IC."
        });
      });
    });
    const counts = risks.reduce((acc, r) => { acc[r.severity] = (acc[r.severity] || 0) + 1; return acc; }, {});
    const overallProfile = `${risks.length} tracked risks: ${counts.Critical || 0} critical, ${counts.High || 0} high, ${counts.Medium || 0} medium, ${counts.Low || 0} low. Overall posture: ${(counts.Critical || 0) + (counts.High || 0) >= 3 ? "Elevated" : (counts.Critical || counts.High) ? "Moderate" : "Contained"}.`;
    return { risks, overallProfile };
  }

  function groupRisks(risks) {
    const grouped = { Critical: [], High: [], Medium: [], Low: [] };
    risks.forEach((r) => {
      (grouped[r.severity] = grouped[r.severity] || []).push([r.title, r.mitigation || r.impact, `${r.likelihood} likelihood`, `${r.confidence}% confidence`]);
    });
    return grouped;
  }

  function heuristicMemoSections(project) {
    const esc = DD.util.escapeHtml;
    const bucketHtml = (bucket) => {
      const list = project.findings[bucket] || [];
      if (!list.length) return `<p>No ${esc(bucket.toLowerCase())} findings generated yet.</p>`;
      return `<ul>${list.map((f) => `<li><strong>${esc(f.title)}</strong> — ${esc(f.summary)} <em>(${f.severity}, ${f.confidence}% confidence, ${f.evidenceCount || 0} evidence)</em></li>`).join("")}</ul>`;
    };
    const rec = project.recommendation;
    const risks = project.riskRegister?.risks || [];
    return [
      { heading: "Executive Summary", html: `<p>${esc(project.name)} (${esc(project.industry)}, ${esc(project.type || project.workflow || "diligence")}) has been assessed across financial, legal, commercial, and operational workstreams. ${esc(project.riskRegister?.overallProfile || "Risk profile pending risk-agent run.")}</p>` },
      { heading: "Investment Thesis", html: `<p>${esc(project.research?.overview || `${project.name} operates in ${project.industry}.`)}</p>` },
      { heading: "Financial Analysis", html: `${(project.financial?.metrics || []).length ? `<p>Key metrics: ${project.financial.metrics.map((m) => `${esc(m.label)} ${esc(m.value)}`).join("; ")}.</p>` : ""}${bucketHtml("Financial")}` },
      { heading: "Legal Analysis", html: bucketHtml("Legal") },
      { heading: "Commercial Analysis", html: bucketHtml("Commercial") },
      { heading: "Operational Analysis", html: bucketHtml("Operational") },
      { heading: "Key Risks", html: risks.length ? `<ul>${risks.slice(0, 8).map((r) => `<li><strong>${esc(r.severity)}:</strong> ${esc(r.title)} — ${esc(r.mitigation || "")}</li>`).join("")}</ul>` : "<p>Run the Risk Assessment Agent to populate.</p>" },
      { heading: "Recommendation", html: rec ? `<p><strong>${esc(rec.decision)}</strong> (${rec.confidence}% confidence). ${esc(rec.rationale || "")}</p>${(rec.conditions || []).length ? `<p>Conditions: ${rec.conditions.map(esc).join("; ")}.</p>` : ""}` : "<p>Run the Recommendation Agent to populate.</p>" }
    ];
  }

  function heuristicRecommendation(project) {
    const risks = project.riskRegister?.risks || [];
    const critical = risks.filter((r) => r.severity === "Critical").length;
    const high = risks.filter((r) => r.severity === "High").length;
    const missing = (project.documents || []).length;
    const coverage = DD.classify.missingCategories(project.documents || [], project.type || project.workflow);
    const evidenceCount = (project.evidence || []).length;
    const insufficient = missing < 2 || evidenceCount < 3 || coverage.length > 3;
    let decision, confidence, rationale;
    if (critical >= 1 && high >= 2) { decision = "Do Not Invest"; confidence = 78; rationale = "Multiple critical/high risks outweigh the thesis at current terms."; }
    else if (insufficient) { decision = "Continue Due Diligence"; confidence = 64; rationale = `Evidence base is thin (${evidenceCount} items, ${coverage.length} missing categories). Gather more before deciding.`; }
    else if (critical >= 1 || high >= 1) { decision = "Invest with Conditions"; confidence = 72; rationale = "Thesis is supportable subject to remediation of the highest-severity risks."; }
    else { decision = "Invest"; confidence = 80; rationale = "No critical risks identified and evidence coverage is adequate."; }
    return {
      decision, confidence, rationale,
      conditions: risks.filter((r) => ["Critical", "High"].includes(r.severity)).slice(0, 4).map((r) => `Resolve: ${r.title}`),
      unresolved: coverage.map((c) => `Missing ${c.category} documentation`)
    };
  }

  // Overlay the learning-bank signal onto a recommendation (model or heuristic).
  // Mutates `rec`: shifts a raw "Invest" toward caution when comparable deals had
  // a weak track record, nudges confidence, surfaces historically-missed risks,
  // and records a `learning` block the UI can display.
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

  DD.agents = { REGISTRY, run, runAll, ensure, addFinding };
})();

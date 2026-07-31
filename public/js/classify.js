/* Sentinel DD — document classification (Phase 3)
 * Deal type (VC/PE/M&A) is a signal passed to the AI agents to tune their
 * analysis — it does not gate or checklist which document categories must be
 * present; a project is never required to have "everything." */
(function () {
  const DD = (window.DD = window.DD || {});

  // category -> { keywords, docTypes }
  const TAXONOMY = [
    { category: "Financial", keywords: ["revenue", "ebitda", "income statement", "balance sheet", "cash flow", "p&l", "gross margin", "arr", "mrr", "budget", "forecast", "audited", "gaap"], docType: "Financial statement" },
    { category: "Legal", keywords: ["agreement", "contract", "msa", "nda", "indemnif", "change of control", "governing law", "litigation", "counsel", "term sheet", "warrant", "lease"], docType: "Contract / legal" },
    { category: "Commercial", keywords: ["customer", "pipeline", "churn", "market", "competitor", "pricing", "sales", "go-to-market", "cohort", "retention", "tam", "sam"], docType: "Commercial / market" },
    { category: "Operational", keywords: ["supplier", "vendor", "process", "sla", "capacity", "headcount", "org chart", "manufacturing", "logistics", "onboarding"], docType: "Operational" },
    { category: "Technology", keywords: ["architecture", "cybersecurity", "soc 2", "iso 27001", "penetration", "infrastructure", "cloud", "codebase", "api", "uptime", "roadmap", "gdpr"], docType: "Technology / security" },
    { category: "Tax", keywords: ["tax", "nexus", "vat", "transfer pricing", "deferred tax", "irs", "withholding"], docType: "Tax" },
    { category: "HR", keywords: ["employee", "compensation", "payroll", "benefits", "equity plan", "option pool", "severance", "employment agreement"], docType: "HR / people" },
    { category: "Corporate", keywords: ["board", "cap table", "articles of incorporation", "bylaws", "minutes", "shareholder", "governance", "certificate of incorporation"], docType: "Corporate / governance" }
  ];

  function scoreCategory(name, text) {
    const haystack = `${name}\n${text}`.toLowerCase();
    let best = { category: "Uncategorized", docType: "Document", score: 0 };
    for (const entry of TAXONOMY) {
      let score = 0;
      for (const keyword of entry.keywords) {
        const hits = haystack.split(keyword).length - 1;
        if (hits) score += hits + (name.toLowerCase().includes(keyword) ? 3 : 0);
      }
      if (score > best.score) best = { category: entry.category, docType: entry.docType, score };
    }
    return best;
  }

  function classify(fileName, extractResult) {
    const { category, docType } = scoreCategory(fileName, extractResult.fullText || "");
    return { category, docType };
  }

  DD.classify = { classify, categories: TAXONOMY.map((t) => t.category) };
})();

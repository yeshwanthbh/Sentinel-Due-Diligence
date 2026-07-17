/* Sentinel DD — document classification & workflow coverage (Phase 3) */
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

  // Which categories each deal type expects to see in the data room.
  const DEAL_TYPE_REQUIREMENTS = {
    "VC": ["Financial", "Commercial", "Technology", "Corporate"],
    "PE": ["Financial", "Legal", "Commercial", "Operational", "Technology", "Tax", "Corporate"],
    "M&A": ["Financial", "Legal", "Commercial", "Operational", "Technology", "Tax", "HR", "Corporate"]
  };

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
    const { category, docType, score } = scoreCategory(fileName, extractResult.fullText || "");
    // confidence blends keyword strength with amount of extractable text
    const textFactor = Math.min(1, (extractResult.wordCount || 0) / 400);
    const keywordFactor = Math.min(1, score / 8);
    let confidence = Math.round(45 + keywordFactor * 45 + textFactor * 8);
    if (extractResult.ocrUsed) confidence -= 6;
    if (!extractResult.fullText) confidence = 30;
    confidence = Math.max(20, Math.min(98, confidence));
    return { category, docType, confidence };
  }

  function requiredCategories(dealType) {
    return DEAL_TYPE_REQUIREMENTS[dealType] || DEAL_TYPE_REQUIREMENTS["VC"];
  }

  function coverage(documents, dealType) {
    const required = requiredCategories(dealType);
    const counts = {};
    documents.forEach((doc) => { counts[doc.category] = (counts[doc.category] || 0) + 1; });
    return required.map((category) => {
      const count = counts[category] || 0;
      const pct = count === 0 ? 0 : Math.min(100, 40 + count * 20);
      const state = count === 0 ? "danger" : count < 2 ? "warning" : "success";
      return { category, count, pct, state };
    });
  }

  function missingCategories(documents, dealType) {
    return coverage(documents, dealType).filter((entry) => entry.count === 0).map((entry) => entry.category);
  }

  DD.classify = { classify, coverage, missingCategories, requiredCategories, categories: TAXONOMY.map((t) => t.category) };
})();

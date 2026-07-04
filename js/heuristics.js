/* Sentinel DD — deterministic analysis engine (no-API fallback)
 * Produces structured, evidence-linked findings from the actual extracted document text
 * so every agent is fully functional offline. When an API key is set, js/agents.js uses
 * the LLM instead and this only supplies the financial number-crunching. */
(function () {
  const DD = (window.DD = window.DD || {});

  // ---------- Financial parsing ----------
  function parseFinancials(text) {
    const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rows = [];
    let periods = [];
    lines.forEach((line) => {
      const cells = line.split(/\t|,|;/).map((c) => c.trim());
      if (cells.length < 2) return;
      const label = cells[0];
      const nums = cells.slice(1).map((c) => Number(String(c).replace(/[$,%()\s]/g, "").replace(/^-$/, "")));
      const numeric = nums.filter((n) => !Number.isNaN(n));
      if (numeric.length && /[a-z]/i.test(label)) {
        rows.push({ label, values: nums.map((n) => (Number.isNaN(n) ? null : n)) });
      } else if (!numeric.length && cells.length > 1 && !periods.length) {
        periods = cells.slice(1);
      }
    });
    const pick = (re) => rows.find((r) => re.test(r.label))?.values || null;
    return {
      periods,
      rows,
      revenue: pick(/revenue|sales|turnover|arr/i),
      cogs: pick(/cogs|cost of (goods|revenue|sales)/i),
      grossProfit: pick(/gross profit/i),
      ebitda: pick(/ebitda/i),
      netIncome: pick(/net income|net profit|net earnings/i),
      opex: pick(/operating expense|opex/i),
      cash: pick(/cash( and| &)? (equivalents|cash)?|cash balance/i),
      debt: pick(/debt|borrowings|notes payable|loan/i),
      currentAssets: pick(/current assets/i),
      currentLiabilities: pick(/current liabilities/i)
    };
  }

  function pctChange(series) {
    if (!series || series.length < 2) return null;
    const first = series.find((n) => n != null);
    const last = [...series].reverse().find((n) => n != null);
    if (first == null || last == null || first === 0) return null;
    return ((last - first) / Math.abs(first)) * 100;
  }

  function ratio(a, b, i) {
    if (!a || !b || a[i] == null || b[i] == null || b[i] === 0) return null;
    return (a[i] / b[i]) * 100;
  }

  function computeFinancialMetrics(parsed) {
    const last = (parsed.periods?.length || (parsed.revenue?.length || 1)) - 1;
    const metrics = [];
    const add = (label, value, hint) => metrics.push({ label, value, hint });
    if (parsed.revenue) {
      add("Revenue (latest)", fmt(parsed.revenue[parsed.revenue.length - 1]), parsed.periods[last] || "");
      const g = pctChange(parsed.revenue);
      if (g != null) add("Revenue growth", `${g.toFixed(1)}%`, "first → latest period");
    }
    const gm = parsed.grossProfit && parsed.revenue
      ? ratio(parsed.grossProfit, parsed.revenue, parsed.revenue.length - 1)
      : (parsed.revenue && parsed.cogs ? (1 - parsed.cogs[parsed.cogs.length - 1] / parsed.revenue[parsed.revenue.length - 1]) * 100 : null);
    if (gm != null) add("Gross margin", `${gm.toFixed(1)}%`, "latest period");
    if (parsed.ebitda && parsed.revenue) {
      const em = ratio(parsed.ebitda, parsed.revenue, parsed.revenue.length - 1);
      if (em != null) add("EBITDA margin", `${em.toFixed(1)}%`, "latest period");
    }
    if (parsed.currentAssets && parsed.currentLiabilities) {
      const cr = ratio(parsed.currentAssets, parsed.currentLiabilities, parsed.currentAssets.length - 1);
      if (cr != null) add("Current ratio", `${(cr / 100).toFixed(2)}x`, "working capital");
    }
    if (parsed.debt && parsed.ebitda) {
      const d = parsed.debt[parsed.debt.length - 1];
      const e = parsed.ebitda[parsed.ebitda.length - 1];
      if (d != null && e) add("Net leverage", `${(d / e).toFixed(2)}x`, "debt / EBITDA");
    }
    return metrics;
  }

  function financialAnomalies(parsed) {
    const anomalies = [];
    const g = pctChange(parsed.revenue);
    if (g != null && g < 0) anomalies.push({ severity: "High", text: `Revenue declined ${Math.abs(g).toFixed(1)}% across the period.` });
    if (g != null && g > 120) anomalies.push({ severity: "Medium", text: `Revenue grew ${g.toFixed(1)}% — validate for non-recurring items or accounting changes.` });
    if (parsed.ebitda) {
      const neg = parsed.ebitda.some((v) => v != null && v < 0);
      if (neg) anomalies.push({ severity: "High", text: "One or more periods show negative EBITDA." });
    }
    if (parsed.grossProfit && parsed.revenue) {
      for (let i = 1; i < parsed.revenue.length; i += 1) {
        const prev = ratio(parsed.grossProfit, parsed.revenue, i - 1);
        const cur = ratio(parsed.grossProfit, parsed.revenue, i);
        if (prev != null && cur != null && Math.abs(cur - prev) > 8) {
          anomalies.push({ severity: "Medium", text: `Gross margin shifted ${(cur - prev).toFixed(1)}pts between periods ${i} and ${i + 1}.` });
          break;
        }
      }
    }
    return anomalies;
  }

  function fmt(n) {
    if (n == null || Number.isNaN(n)) return "—";
    if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return String(n);
  }

  // ---------- Document signal libraries (per agent) ----------
  const SIGNALS = {
    "legal-agent": [
      { kw: ["change of control", "change-of-control"], title: "Change-of-control exposure", severity: "High", summary: "Contract language includes change-of-control provisions that may require counterparty consent or trigger renegotiation at close." },
      { kw: ["indemnif"], title: "Indemnification obligations", severity: "Medium", summary: "Broad indemnification obligations identified that warrant caps and survival-period review." },
      { kw: ["litigation", "lawsuit", "plaintiff", "defendant"], title: "Litigation reference", severity: "High", summary: "Documents reference active or threatened litigation requiring legal exposure quantification." },
      { kw: ["exclusiv"], title: "Exclusivity commitments", severity: "Medium", summary: "Exclusivity terms may constrain commercial flexibility post-acquisition." },
      { kw: ["auto-renew", "automatic renewal", "evergreen"], title: "Auto-renewal terms", severity: "Low", summary: "Auto-renewal clauses affect revenue durability assumptions and termination rights." },
      { kw: ["non-compete", "noncompete"], title: "Restrictive covenants", severity: "Medium", summary: "Non-compete / restrictive covenants present enforceability and retention considerations." }
    ],
    "commercial-agent": [
      { kw: ["churn", "attrition"], title: "Customer churn signal", severity: "Medium", summary: "Churn/attrition data present; validate net revenue retention against the growth case." },
      { kw: ["top customer", "customer concentration", "largest customer"], title: "Customer concentration", severity: "High", summary: "Materials indicate revenue concentration among top customers, a durability risk to the plan." },
      { kw: ["discount", "pricing pressure"], title: "Pricing pressure", severity: "Medium", summary: "Evidence of discounting or competitive pricing pressure affecting realized ARPU." },
      { kw: ["pipeline", "bookings"], title: "Pipeline coverage", severity: "Low", summary: "Pipeline data available to test forward bookings coverage versus forecast." },
      { kw: ["competitor", "market share"], title: "Competitive dynamics", severity: "Low", summary: "Competitive positioning references identified for market-sizing cross-check." }
    ],
    "operational-agent": [
      { kw: ["soc 2", "iso 27001", "penetration test"], title: "Security posture", severity: "Medium", summary: "Security certification/remediation evidence found; verify status and closure dates." },
      { kw: ["single supplier", "sole source", "key supplier", "vendor dependency"], title: "Supplier concentration", severity: "High", summary: "Dependency on a limited supplier base introduces operational continuity risk." },
      { kw: ["downtime", "outage", "uptime"], title: "Reliability signal", severity: "Medium", summary: "Availability/incident references require SLA and reliability assessment." },
      { kw: ["key person", "key-person", "single point"], title: "Key-person risk", severity: "Medium", summary: "Concentration of critical knowledge in individuals without documented coverage." },
      { kw: ["scalab", "capacity"], title: "Scalability constraint", severity: "Low", summary: "Capacity/scalability considerations to validate against the growth plan." },
      { kw: ["gdpr", "hipaa", "compliance"], title: "Regulatory/compliance exposure", severity: "Medium", summary: "Regulatory obligations referenced that require compliance validation." }
    ]
  };

  function severityConfidence(severity, matchStrength) {
    const base = { High: 88, Medium: 80, Low: 72 }[severity] || 75;
    return Math.min(97, base + Math.min(8, matchStrength));
  }

  DD.heuristics = {
    parseFinancials,
    computeFinancialMetrics,
    financialAnomalies,
    pctChange,
    fmt,
    SIGNALS,
    severityConfidence
  };
})();

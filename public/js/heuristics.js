/* Sentinel DD — deterministic financial math
 * Parses financial statement text into structured rows and computes
 * growth/margin/anomaly figures. This is exact number-crunching the Financial
 * Agent relies on regardless of which AI answers — not an alternative to the
 * AI (agents.js requires a configured model; see its header comment). */
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

  DD.heuristics = {
    parseFinancials,
    computeFinancialMetrics,
    financialAnomalies,
    pctChange,
    fmt
  };
})();

// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";

beforeAll(async () => {
  await import("../public/js/store.js");
  await import("../public/js/heuristics.js");
});

describe("parseFinancials", () => {
  it("extracts labeled rows and their numeric values", () => {
    const text = "Metric, FY23, FY24\nRevenue, 100, 145\nCOGS, 40, 52\nEBITDA, 12, 24";
    const parsed = window.DD.heuristics.parseFinancials(text);
    expect(parsed.revenue).toEqual([100, 145]);
    expect(parsed.cogs).toEqual([40, 52]);
    expect(parsed.ebitda).toEqual([12, 24]);
  });

  it("strips currency formatting from numbers (tab-delimited, e.g. spreadsheet paste)", () => {
    const parsed = window.DD.heuristics.parseFinancials("Revenue\t$1000\t$1200");
    expect(parsed.revenue).toEqual([1000, 1200]);
  });

  // Comma is also the column delimiter, so a comma-formatted thousands separator
  // (e.g. "$1,000") is indistinguishable from a second column — a real parsing
  // limitation of the comma-delimited input path, not a regression to "fix" here.
  it("comma-delimited input cannot disambiguate a comma thousands-separator from a column break", () => {
    const parsed = window.DD.heuristics.parseFinancials("Revenue, $1,000, $1,200");
    expect(parsed.revenue).not.toEqual([1000, 1200]);
  });

  it("returns nulls for series it can't find", () => {
    const parsed = window.DD.heuristics.parseFinancials("Revenue, 100, 120");
    expect(parsed.debt).toBeNull();
    expect(parsed.ebitda).toBeNull();
  });

  it("handles empty/garbage input without throwing", () => {
    expect(() => window.DD.heuristics.parseFinancials("")).not.toThrow();
    expect(() => window.DD.heuristics.parseFinancials("not,a,number,here")).not.toThrow();
  });
});

describe("computeFinancialMetrics", () => {
  it("computes revenue growth and gross margin from parsed rows", () => {
    const parsed = window.DD.heuristics.parseFinancials(
      "Revenue, 100, 200\nGross Profit, 60, 130"
    );
    const metrics = window.DD.heuristics.computeFinancialMetrics(parsed);
    const growth = metrics.find((m) => m.label === "Revenue growth");
    const margin = metrics.find((m) => m.label === "Gross margin");
    expect(growth.value).toBe("100.0%");
    expect(margin.value).toBe("65.0%"); // 130/200
  });

  it("returns no metrics for a dataset with nothing recognizable", () => {
    const parsed = window.DD.heuristics.parseFinancials("Foo, 1, 2");
    expect(window.DD.heuristics.computeFinancialMetrics(parsed)).toEqual([]);
  });
});

describe("financialAnomalies", () => {
  it("flags a revenue decline as High severity", () => {
    const parsed = window.DD.heuristics.parseFinancials("Revenue, 200, 100");
    const anomalies = window.DD.heuristics.financialAnomalies(parsed);
    expect(anomalies.some((a) => a.severity === "High" && /declined/.test(a.text))).toBe(true);
  });

  it("flags negative EBITDA as High severity", () => {
    const parsed = window.DD.heuristics.parseFinancials("Revenue, 100, 110\nEBITDA, 5, -3");
    const anomalies = window.DD.heuristics.financialAnomalies(parsed);
    expect(anomalies.some((a) => a.severity === "High" && /negative EBITDA/.test(a.text))).toBe(true);
  });

  it("does not flag steady, modest growth", () => {
    const parsed = window.DD.heuristics.parseFinancials("Revenue, 100, 110\nEBITDA, 5, 8");
    const anomalies = window.DD.heuristics.financialAnomalies(parsed);
    expect(anomalies.some((a) => a.severity === "High")).toBe(false);
  });
});

// Note: severityConfidence and the SIGNALS keyword library were removed along
// with heuristicDocumentFindings — the app no longer has a keyword-based
// substitute for document-agent findings (see agents.js header).

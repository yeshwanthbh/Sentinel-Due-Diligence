// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";

beforeAll(async () => {
  await import("../public/js/store.js");
  await import("../public/js/classify.js");
  await import("../public/js/heuristics.js");
  await import("../public/js/agents.js");
});

function baseProject(overrides = {}) {
  return {
    name: "Acme Robotics", industry: "Industrial automation", type: "VC", workflow: "VC",
    documents: [], findings: {}, ...overrides
  };
}

describe("addFinding", () => {
  it("creates a new finding with the expected shape", () => {
    const project = baseProject();
    const f = window.DD.agents.addFinding(project, "Financial", { title: "Revenue concentration", summary: "Top 2 customers.", severity: "High", confidence: 82, agent: "Financial Agent" });
    expect(project.findings.Financial).toHaveLength(1);
    expect(f.status).toBe("Needs Review");
    expect(f.id).toBeTruthy();
    // Regression guard: findings must not carry an evidence-citation footprint —
    // the evidence engine was intentionally removed from the product.
    expect(f).not.toHaveProperty("evidenceIds");
    expect(f).not.toHaveProperty("evidenceCount");
  });

  it("dedupes by title within a bucket — a second call updates, not duplicates", () => {
    const project = baseProject();
    window.DD.agents.addFinding(project, "Financial", { title: "Revenue concentration", summary: "v1", severity: "Medium", confidence: 60 });
    window.DD.agents.addFinding(project, "Financial", { title: "Revenue concentration", summary: "v2", severity: "High", confidence: 90 });
    expect(project.findings.Financial).toHaveLength(1);
    expect(project.findings.Financial[0].summary).toBe("v2");
    expect(project.findings.Financial[0].severity).toBe("High");
  });
});

describe("heuristicRecommendation", () => {
  it("recommends Do Not Invest when there are multiple critical/high risks", () => {
    const project = baseProject({
      documents: [{ category: "Financial" }, { category: "Legal" }, { category: "Commercial" }],
      riskRegister: { risks: [{ severity: "Critical" }, { severity: "High" }, { severity: "High" }] }
    });
    const rec = window.DD.agents.heuristicRecommendation(project);
    expect(rec.decision).toBe("Do Not Invest");
  });

  it("recommends Continue Due Diligence when document coverage is thin, regardless of risk", () => {
    const project = baseProject({ documents: [], riskRegister: { risks: [] } });
    const rec = window.DD.agents.heuristicRecommendation(project);
    expect(rec.decision).toBe("Continue Due Diligence");
  });

  it("recommends Invest when risk is clean and coverage is adequate", () => {
    const project = baseProject({
      documents: [{ category: "Financial" }, { category: "Legal" }, { category: "Commercial" }, { category: "Operational" }],
      riskRegister: { risks: [{ severity: "Low" }] }
    });
    const rec = window.DD.agents.heuristicRecommendation(project);
    expect(rec.decision).toBe("Invest");
  });

  it("rationale text never mentions 'evidence' — the evidence-sufficiency gate was removed", () => {
    const project = baseProject({ documents: [], riskRegister: { risks: [] } });
    const rec = window.DD.agents.heuristicRecommendation(project);
    expect(rec.rationale.toLowerCase()).not.toContain("evidence");
  });
});

describe("heuristicCrossValidation", () => {
  it("flags duplicate documents as a Low-severity contradiction", () => {
    const project = baseProject({
      documents: [{ name: "msa.pdf", duplicateOf: null }, { name: "msa (copy).pdf", duplicateOf: "id-1" }]
    });
    const result = window.DD.agents.heuristicCrossValidation(project);
    expect(result.contradictions.some((c) => c.topic === "Duplicate documents")).toBe(true);
  });

  it("flags a large mismatch between a narrative growth claim and computed revenue growth", () => {
    const project = baseProject({
      findings: { Financial: [{ title: "x", summary: "Management reports strong 90% growth this year." }] },
      financial: { parsed: { revenue: [100, 105] } } // computed growth ~5%, claimed 90% -> mismatch
    });
    const result = window.DD.agents.heuristicCrossValidation(project);
    expect(result.contradictions.some((c) => c.topic === "Revenue growth rate")).toBe(true);
  });

  it("returns no contradictions for a clean, consistent project", () => {
    const project = baseProject({ documents: [], findings: {} });
    const result = window.DD.agents.heuristicCrossValidation(project);
    expect(result.contradictions).toEqual([]);
  });
});

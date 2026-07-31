// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";

beforeAll(async () => {
  await import("../public/js/store.js");
  await import("../public/js/classify.js");
  await import("../public/js/heuristics.js");
  await import("../public/js/llm.js");
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

// Note: heuristicRecommendation was intentionally removed — the app requires a
// configured OpenAI key for every decision-making agent and no longer has any
// deterministic substitute for the recommendation itself (see agents.js header).

describe("run() with no AI key configured", () => {
  it("rejects with a clear error instead of silently falling back to anything", async () => {
    // js/llm.js defaults to unconfigured until refreshStatus() is called against
    // a real server, which never happens in this test — isConfigured() is false.
    expect(window.DD.llm.isConfigured()).toBe(false);
    const project = baseProject();
    await expect(window.DD.agents.run(project, "research-agent")).rejects.toThrow(/requires an AI key/i);
  });
});

describe("deterministicCrossChecks", () => {
  it("flags duplicate documents as a Low-severity contradiction", () => {
    const project = baseProject({
      documents: [{ name: "msa.pdf", duplicateOf: null }, { name: "msa (copy).pdf", duplicateOf: "id-1" }]
    });
    const result = window.DD.agents.deterministicCrossChecks(project);
    expect(result.contradictions.some((c) => c.topic === "Duplicate documents")).toBe(true);
  });

  it("flags a large mismatch between a narrative growth claim and computed revenue growth", () => {
    const project = baseProject({
      findings: { Financial: [{ title: "x", summary: "Management reports strong 90% growth this year." }] },
      financial: { parsed: { revenue: [100, 105] } } // computed growth ~5%, claimed 90% -> mismatch
    });
    const result = window.DD.agents.deterministicCrossChecks(project);
    expect(result.contradictions.some((c) => c.topic === "Revenue growth rate")).toBe(true);
  });

  it("returns no contradictions for a clean, consistent project", () => {
    const project = baseProject({ documents: [], findings: {} });
    const result = window.DD.agents.deterministicCrossChecks(project);
    expect(result.contradictions).toEqual([]);
  });
});

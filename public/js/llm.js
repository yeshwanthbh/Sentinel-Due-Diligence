/* Sentinel DD — LLM client (server-proxied)
 * The model API key is a server secret and never reaches the browser. This
 * module keeps only the user's provider/model *preference* (which model to ask
 * the server to use) and routes every call through the authenticated proxy
 * (/api/llm). If the server has no key, agents fall back to the heuristic engine. */
(function () {
  const DD = (window.DD = window.DD || {});
  const CONFIG_KEY = "sentinel-dd-llm";

  const DEFAULTS = {
    provider: "claude",           // "claude" | "openai" — preference only
    claudeModel: "claude-opus-4-8",
    openaiModel: "gpt-4o"
  };

  // Server AI availability, cached from /api/llm/status (see refreshStatus).
  let status = { configured: false, provider: "claude", dailyLimit: null };

  function getConfig() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}") }; }
    catch { return { ...DEFAULTS }; }
  }

  function setConfig(patch) {
    const next = { ...getConfig(), ...patch };
    delete next.apiKey; // never persist a key on the client
    localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
    return next;
  }

  // Whether the SERVER has a model key configured. Cached; refreshed on login.
  function isConfigured() { return Boolean(status.configured); }
  function getStatus() { return { ...status }; }

  async function refreshStatus() {
    try { status = await DD.api.llm.status(); }
    catch { status = { configured: false, provider: getConfig().provider, dailyLimit: null }; }
    return status;
  }

  function extractJson(raw) {
    if (!raw) throw new Error("Empty model response");
    const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try { return JSON.parse(text); } catch { /* fall through */ }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Model did not return valid JSON");
  }

  /* Run a specialized agent prompt through the server proxy and return parsed JSON.
   * system: the agent's specialization prompt. user: the diligence context payload. */
  async function runJSON(system, user) {
    const cfg = getConfig();
    const model = cfg.provider === "openai" ? cfg.openaiModel : cfg.claudeModel;
    const { text } = await DD.api.llm.run({ system, user, provider: cfg.provider, model });
    return extractJson(text);
  }

  /* Verify the server can actually reach the model, end-to-end (one small call). */
  async function testConnection() {
    try {
      const cfg = getConfig();
      const model = cfg.provider === "openai" ? cfg.openaiModel : cfg.claudeModel;
      const { text } = await DD.api.llm.run({
        system: 'Reply with a tiny JSON object like {"ok":true}.',
        user: "ping", provider: cfg.provider, model, maxTokens: 20
      });
      await refreshStatus();
      return { ok: true, provider: cfg.provider, model, message: `Server reached ${cfg.provider === "openai" ? "OpenAI" : "Claude"} (${model}). Reply: ${(text || "").slice(0, 40)}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  DD.llm = { getConfig, setConfig, isConfigured, getStatus, refreshStatus, runJSON, extractJson, testConnection };
})();

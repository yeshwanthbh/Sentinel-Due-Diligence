/* Sentinel DD — LLM client (server-proxied)
 * OpenAI is the sole provider — the model API key is a server secret and never
 * reaches the browser. This module keeps only the user's model *preference*
 * (which model to ask the server to use) and routes every call through the
 * authenticated proxy (/api/llm). There is no fallback engine: if the server
 * has no key, or the call fails, agents throw rather than substituting
 * anything (see public/js/agents.js). */
(function () {
  const DD = (window.DD = window.DD || {});
  const CONFIG_KEY = "sentinel-dd-llm";

  const DEFAULTS = { model: "gpt-4o" };

  // Server AI availability, cached from /api/llm/status (see refreshStatus).
  let status = { configured: false, dailyLimit: null };

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
    catch { status = { configured: false, dailyLimit: null }; }
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
    const { model } = getConfig();
    const { text } = await DD.api.llm.run({ system, user, model });
    return extractJson(text);
  }

  /* Verify the server can actually reach OpenAI, end-to-end (one small call). */
  async function testConnection() {
    try {
      const { model } = getConfig();
      const { text } = await DD.api.llm.run({
        system: 'Reply with a tiny JSON object like {"ok":true}.',
        user: "ping", model
      });
      await refreshStatus();
      return { ok: true, model, message: `Server reached OpenAI (${model}). Reply: ${(text || "").slice(0, 40)}` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  DD.llm = { getConfig, setConfig, isConfigured, getStatus, refreshStatus, runJSON, extractJson, testConnection };
})();

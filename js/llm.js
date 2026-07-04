/* Sentinel DD — LLM client
 * Agents are built on an existing model (Claude or OpenAI ChatGPT); each agent is
 * "specialized" purely through its system prompt + JSON schema. If no key is set,
 * agents transparently fall back to the deterministic heuristic engine (js/heuristics.js). */
(function () {
  const DD = (window.DD = window.DD || {});
  const CONFIG_KEY = "sentinel-dd-llm";

  const DEFAULTS = {
    provider: "claude",           // "claude" | "openai"
    apiKey: "",
    claudeModel: "claude-opus-4-8",
    openaiModel: "gpt-4o"
  };

  function getConfig() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}") }; }
    catch { return { ...DEFAULTS }; }
  }

  function setConfig(patch) {
    const next = { ...getConfig(), ...patch };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
    return next;
  }

  function isConfigured() {
    return Boolean(getConfig().apiKey);
  }

  function extractJson(raw) {
    if (!raw) throw new Error("Empty model response");
    let text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try { return JSON.parse(text); } catch { /* fall through */ }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON");
  }

  async function callClaude(system, user, config) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: config.claudeModel,
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: user }]
      })
    });
    if (!response.ok) throw new Error(`Claude API ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return (data.content || []).map((block) => block.text || "").join("");
  }

  async function callOpenAI(system, user, config) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.openaiModel,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }

  /* Run a specialized agent prompt and return parsed JSON.
   * system: the agent's specialization prompt. user: the diligence context payload. */
  async function runJSON(system, user) {
    const config = getConfig();
    if (!config.apiKey) throw new Error("NO_KEY");
    const raw = config.provider === "openai"
      ? await callOpenAI(system, user, config)
      : await callClaude(system, user, config);
    return extractJson(raw);
  }

  /* Make a minimal live call to verify the key actually authenticates and the
   * chosen model is reachable. Returns { ok, provider, model, message }. */
  async function testConnection(override) {
    const config = { ...getConfig(), ...(override || {}) };
    if (!config.apiKey) return { ok: false, provider: config.provider, message: "No API key set." };
    const model = config.provider === "openai" ? config.openaiModel : config.claudeModel;
    try {
      if (config.provider === "openai") {
        // Mirror the real agent call: json_object response format + a "json" mention.
        // This catches models that authenticate fine but reject JSON mode, so a
        // passing test actually predicts that the agents will work.
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({
            model, max_tokens: 5,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: 'Reply with a tiny json object like {"ok":true}.' }]
          })
        });
        if (res.ok) return { ok: true, provider: "openai", model, message: `Connected to OpenAI (${model}) with JSON mode — agents will use the live model.` };
        return { ok: false, provider: "openai", model, message: friendlyError(res.status, await safeText(res), "openai", model) };
      }
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] })
      });
      if (res.ok) return { ok: true, provider: "claude", model, message: `Connected to Claude (${model}).` };
      return { ok: false, provider: "claude", model, message: friendlyError(res.status, await safeText(res), "claude", model) };
    } catch (err) {
      // A network/CORS failure lands here — the request never got a response.
      return { ok: false, provider: config.provider, model, message: `Network error: ${err.message}. Check your connection and that the key/provider are correct.` };
    }
  }

  async function safeText(res) { try { return await res.text(); } catch { return ""; } }

  function friendlyError(status, body, provider, model) {
    if (status === 401 || status === 403) return "Authentication failed — the API key is invalid or lacks access.";
    if (status === 404) return `Model "${model}" not found for ${provider === "openai" ? "OpenAI" : "Claude"}. Check the model name.`;
    if (status === 429) return "Key is valid but rate-limited or out of quota/credits.";
    let detail = "";
    try { const j = JSON.parse(body); detail = j.error?.message || j.message || ""; } catch { detail = (body || "").slice(0, 160); }
    return `API error ${status}${detail ? `: ${detail}` : ""}.`;
  }

  DD.llm = { getConfig, setConfig, isConfigured, runJSON, extractJson, testConnection };
})();

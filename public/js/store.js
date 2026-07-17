/* Sentinel DD — shared utilities
 * Persistence now lives server-side (Cloudflare Worker + D1 + R2) behind
 * window.DD.api. This module keeps only the framework-free helpers every other
 * script relies on: id/clone/escape and a content-hash function used by the
 * data room to dedupe uploads before sending them to R2. */
(function () {
  const DD = (window.DD = window.DD || {});

  function cryptoId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[char]);
  }

  async function sha256Hex(arrayBuffer) {
    if (window.crypto?.subtle) {
      const digest = await window.crypto.subtle.digest("SHA-256", arrayBuffer);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    // Fallback content hash (non-crypto) for environments without SubtleCrypto.
    const bytes = new Uint8Array(arrayBuffer);
    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i += 1) {
      hash ^= bytes[i];
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(16);
  }

  DD.util = { cryptoId, clone, escapeHtml };
  DD.db = { sha256Hex };
})();

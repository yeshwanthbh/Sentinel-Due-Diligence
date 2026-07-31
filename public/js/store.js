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

  // Allowlist-based sanitizer for the investment memo's HTML. The Memo Agent's
  // model path returns raw HTML built from untrusted uploaded-document text, so
  // a prompt-injection payload in a document could otherwise smuggle executable
  // markup (e.g. an onerror handler) into innerHTML and Word-export output.
  // Strips every tag/attribute outside a small safe formatting allowlist.
  const MEMO_ALLOWED_TAGS = new Set([
    "H1", "H2", "H3", "H4", "P", "UL", "OL", "LI", "STRONG", "B", "EM", "I",
    "BLOCKQUOTE", "BR", "SPAN", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "A", "HR"
  ]);
  function sanitizeMemoHtml(html) {
    if (!html) return "";
    if (typeof DOMParser === "undefined") return escapeHtml(html); // non-browser context
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    const walk = (node) => {
      [...node.childNodes].forEach((child) => {
        if (child.nodeType === 1) { // ELEMENT_NODE
          if (!MEMO_ALLOWED_TAGS.has(child.tagName)) {
            child.replaceWith(doc.createTextNode(child.textContent || ""));
            return;
          }
          [...child.attributes].forEach((attr) => {
            if (child.tagName === "A" && attr.name === "href" && /^https?:\/\//i.test(attr.value)) return;
            child.removeAttribute(attr.name);
          });
          walk(child);
        } else if (child.nodeType !== 3) { // not a TEXT_NODE either — comments, etc.
          child.remove();
        }
      });
    };
    walk(doc.body);
    return doc.body.innerHTML;
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

  DD.util = { cryptoId, clone, escapeHtml, sanitizeMemoHtml };
  DD.db = { sha256Hex };
})();

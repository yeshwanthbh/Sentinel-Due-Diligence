# Sentinel DD — AI Due Diligence Platform

Sentinel DD is a browser-based **due-diligence operating system** for private-market
investors (VC, PE, M&A). Upload a data room, run a team of specialized AI agents, and
get evidence-linked findings, a risk register, an editable investment memo, and an
investment recommendation — all exportable to PDF/Word/Excel/PowerPoint.

It runs entirely in the browser. Accounts, projects, documents, evidence, and findings
are stored locally in **IndexedDB**. No backend is required.

---

## Highlights

- **Virtual data room** — drag-and-drop files or whole folders. Text extraction (with
  OCR fallback), deduplication, automatic classification, and coverage checks.
- **AI agent orchestrator** — nine specialized agents (research, financial, legal,
  commercial, operational, cross-validation, risk, memo, recommendation) built on one
  underlying model (Claude or OpenAI), specialized by prompt.
- **Evidence engine** — every finding links back to a source document, page, and excerpt
  with a confidence score.
- **Findings, risks, memo, reports** — reviewer workflow with an audit log, a severity
  risk register, an editable IC memo, and one-click exports.
- **Proprietary learning & post-deal intelligence** — the platform gets smarter with
  every closed deal (see below).
- **Auth** — local email/password accounts plus optional **Sign in with Google**.
- **Bring-your-own-key AI** — add a Claude or OpenAI key in Settings for live analysis;
  without a key a deterministic heuristic engine runs so the app is fully usable offline.

---

## Running locally

Google sign-in and the LLM calls require an `http(s)` origin — **the app will not work
from a `file://` page**. Serve the folder with any static server:

```bash
# Python
python -m http.server 4599

# or Node
npx serve -l 4599
```

Then open **http://localhost:4599**.

### Enable "Sign in with Google" (optional)

1. [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
   → **Create credentials → OAuth client ID → Web application**.
2. Add your serving URL (e.g. `http://localhost:4599`) under **Authorized JavaScript origins**.
3. Paste the Client ID into [`config.js`](config.js):
   ```js
   window.SENTINEL_CONFIG = { googleClientId: "…apps.googleusercontent.com" };
   ```
4. Add yourself as a **Test user** on the OAuth consent screen (or publish the app).

The official Google button then renders automatically for every visitor.

### Enable live AI analysis (optional)

Go to **Settings → AI Engine**, choose a provider (Anthropic Claude or OpenAI), enter a
model and API key, and click **Test connection**. Keys are stored only in your browser.
Without a key, agents fall back to the deterministic heuristic engine.

---

## Proprietary Learning & Post-Deal Intelligence

The platform continuously improves by learning from completed engagements.

**Contributing an outcome.** After a deal is finalized, open **Deal Intelligence** and
optionally submit the outcome: whether the deal closed, the final purchase price, the key
risks that materialized, the risks that were missed, and an overall 1–5 success rating.
Submission requires an explicit **consent** checkbox.

**What is stored (privacy model).** With consent, only an **anonymized, structured**
record is retained — **never the original confidential documents, evidence excerpts, memo
text, company name, or team**. Each record holds:

- deal descriptors: industry, deal type, and deal-size band;
- a pre-close analysis snapshot: the recommendation and risk-severity counts/categories;
- the user-submitted outcome fields above.

**How it improves future analysis.** When you analyze a new company, Sentinel finds
**comparable past deals** (by type, industry, size, and risk profile) and feeds their
anonymized outcomes to the Risk, Memo, and Recommendation agents as additional evidence.
The recommendation is then calibrated to that track record — for example, a raw "Invest"
is nudged toward "Invest with Conditions" when similar deals fared poorly, and risks that
those deals **missed** are surfaced as items still to check. This applies whether the live
model or the heuristic engine is running.

The **Learning Bank** panel shows aggregate stats and lets you delete your own contributions.

---

## Architecture

Plain HTML/CSS/JS — no build step. Everything hangs off a global `window.DD` namespace so
the non-module scripts can share state. Load order matters and is defined in
[`index.html`](index.html).

| File | Responsibility |
|------|----------------|
| [`index.html`](index.html) | App shell, all page sections, script load order |
| [`app.js`](app.js) | UI orchestration, auth, routing, rendering, event wiring |
| [`config.js`](config.js) | Deployment config (Google OAuth Client ID) |
| [`styles.css`](styles.css) | Styling (light/dark) |
| [`js/store.js`](js/store.js) | IndexedDB layer, hashing, shared utils |
| [`js/extract.js`](js/extract.js) | File text extraction (PDF/DOCX/XLSX/…), OCR |
| [`js/classify.js`](js/classify.js) | Document categorization & coverage |
| [`js/evidence.js`](js/evidence.js) | Evidence/citation engine |
| [`js/llm.js`](js/llm.js) | Claude/OpenAI client + connection test |
| [`js/heuristics.js`](js/heuristics.js) | Deterministic fallback analysis engine |
| [`js/learning.js`](js/learning.js) | Post-deal learning bank & comparable-deal intelligence |
| [`js/agents.js`](js/agents.js) | AI agent registry & orchestration |
| [`js/dataroom.js`](js/dataroom.js) | Data-room ingestion pipeline |
| [`js/review.js`](js/review.js) | Finding review workflow & versioning |
| [`js/exporter.js`](js/exporter.js) | PDF/Word/Excel/PowerPoint exports |

### Data storage (IndexedDB)

Database `sentinel-dd-db` (v3), object stores:

- `users` — accounts (email index)
- `projects` — full project state (owner index)
- `docblobs` — raw file blobs + extracted text
- `outcomes` — anonymized post-deal learning bank

---

## Security notes

This is a **prototype**. Password hashing, Google ID-token decoding (unverified), and API
keys stored client-side are acceptable for local/demo use but are **not** production-grade.
A production deployment should verify tokens server-side, proxy model calls through a
backend, and never expose API keys in the browser.

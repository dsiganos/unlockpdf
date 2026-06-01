# Architecture Design Document — UnlockPDF

**Status:** Implemented · **Last updated:** 2026-06-01

---

## 1. Overview

A web application that removes the password from a password-protected PDF. The defining
architectural decision is that **all processing happens in the user's browser** — the PDF
is never transmitted to any server. The entire product is a set of static files (HTML, CSS,
JS, and a WebAssembly binary) served from a free static host.

> "Remove the password" here means: the user supplies a password they already know, the app
> decrypts the document and re-saves it with encryption stripped. It is **not** a
> password-recovery / cracking tool.

---

## 2. Goals & Non-Goals

### Goals
- **Privacy by construction.** Files never leave the device; there is no server to leak,
  log, or retain them.
- **Maximally static.** No backend, no build step, no runtime dependencies on a server.
  Deployable to any static host (target: GitHub Pages) for free.
- **Self-contained & offline-capable.** The decryption engine is vendored, not pulled from
  a CDN at runtime.
- **Responsive UX.** Decryption of large files must not freeze the page.

### Non-Goals
- Password **recovery/brute-forcing** of unknown passwords (cryptographically infeasible and
  out of scope).
- Server-side processing, user accounts, persistence, or analytics.
- Editing/converting PDFs beyond removing encryption.

---

## 3. Key Architectural Decisions

| # | Decision | Rationale | Trade-off accepted |
|---|----------|-----------|--------------------|
| D1 | **Client-side only (no backend)** | Privacy + zero hosting cost + trivial scaling | All compute runs on the user's device; large files use client RAM |
| D2 | **MuPDF compiled to WebAssembly** as the engine | Mature C library; opens encrypted PDFs, authenticates, and re-saves decrypted — all in-browser | ~10 MB wasm payload; AGPL license to honor |
| D3 | **Vendored library** (`vendor/mupdf/`), not a CDN import | Offline-capable, no third-party runtime dependency, version-pinned, no supply-chain fetch at runtime | Must manually re-vendor on upgrade |
| D4 | **Decryption in a Web Worker** | Keeps the WASM compile + decrypt off the main thread so the UI never freezes | Slightly more code; data passed via transferable `ArrayBuffer`s |
| D5 | **Single-threaded WASM build** | Avoids `SharedArrayBuffer`, which requires COOP/COEP headers that GitHub Pages cannot set | No multi-threaded speedup |
| D6 | **No build step / bundler** — plain ES modules | "As static as possible"; files served verbatim; trivial to audit and deploy | No tree-shaking/minification |
| D7 | **GitHub Pages via Actions** | Free, push-to-deploy, no header config needed (see D5) | Tied to GitHub; large wasm served each cold load |

---

## 4. System Context

```
        ┌─────────────────────────────────────────────────────────┐
        │                     User's Browser                        │
        │                                                           │
        │   index.html ──loads──► app.js (main thread, UI)          │
        │                              │                            │
        │                  postMessage │ ▲ postMessage              │
        │                  (transfer)  ▼ │ (transfer)               │
        │                         worker.js (Web Worker)            │
        │                              │                            │
        │                       import │                            │
        │                              ▼                            │
        │                  vendor/mupdf/mupdf.js                    │
        │                              │                            │
        │                       instantiates                        │
        │                              ▼                            │
        │                  mupdf-wasm.wasm  (MuPDF engine)          │
        └─────────────────────────────────────────────────────────┘
                              ▲
                              │ one-time static GET of files
                              │ (HTML/CSS/JS/WASM) — NO file upload
                              │
                   ┌──────────────────────┐
                   │  Static host (GH Pages) │
                   └──────────────────────┘
```

The only network traffic is the **one-time download of the static assets**. The user's PDF
bytes stay entirely within the browser tab; they flow main thread → worker → wasm → back, all
in-process.

---

## 5. Components

### 5.1 UI layer — `index.html`, `styles.css`, `app.js`
- **`index.html`** — semantic, accessible markup: a drag-and-drop dropzone that doubles as a
  file picker, a password field with show/hide, a "Remove password" action, a status/result
  region, a prominent privacy callout, and a "how it works" FAQ.
- **`styles.css`** — framework-free, web-font-free (offline-safe), responsive, with
  `prefers-color-scheme` light/dark and explicit styling for dropzone drag-over, disabled
  button, and info/success/error/warn states.
- **`app.js`** — the controller (ES module). Owns UI state (`workerReady`, `selectedFile`,
  `inFlight`, `triedPassword`), reads the chosen `File` to an `ArrayBuffer`, sends work to the
  worker, and renders each worker response. On success it wraps the returned bytes in a
  `Blob` and triggers a download.

### 5.2 Decryption worker — `worker.js`
A **module Web Worker** (`new Worker("./worker.js", { type: "module" })`). It imports the
vendored MuPDF, then per request:
1. `mupdf.Document.openDocument(new Uint8Array(buffer), "application/pdf")`
2. If `doc.needsPassword()` and the supplied password is empty/wrong → reply `needPassword`.
3. `doc.authenticatePassword(password)` (nonzero = success).
4. `doc.saveToBuffer("decrypt=yes")` → decrypted PDF bytes → reply `success`.
5. Any throw → reply `error`. MuPDF objects are freed best-effort via `.destroy()`.

> **Critical engine detail:** `saveToBuffer("")` *preserves* the original encryption. The
> option **`"decrypt=yes"`** is required to actually strip it. This was discovered during
> implementation and confirmed by an independent `qpdf --is-encrypted` cross-check.

### 5.3 Engine — `vendor/mupdf/`
MuPDF **1.27.0**, copied from the npm package's `dist/`:
- `mupdf.js` — JS API wrapper (ES module; does a top-level `await` to init the wasm).
- `mupdf-wasm.js` — Emscripten glue; locates the binary via `new URL("mupdf-wasm.wasm",
  import.meta.url)`, so all three files must live in the same directory.
- `mupdf-wasm.wasm` — the ~10 MB engine binary.
- `package.json` (`{"type":"module"}`) — scopes this subtree to ESM so Node tooling/tests
  treat `mupdf.js` correctly regardless of the root package config.

### 5.4 Deploy & docs — `.github/workflows/deploy.yml`, `.nojekyll`, `README.md`, `.gitignore`
- **Workflow:** official GitHub Pages flow — `upload-pages-artifact@v3` (path `.`) +
  `deploy-pages@v4`, permissions `pages: write` + `id-token: write`, triggered on push to
  `main`/`master` and `workflow_dispatch`. No install/build step.
- **`.nojekyll`:** disables Jekyll so the `vendor/` directory is served untouched.
- **`.gitignore`:** excludes `node_modules/`, `test/tmp/`, and root scratch PDFs.

### 5.5 Test — `test/decrypt.test.mjs`
A Node ES-module test that generates a valid PDF, encrypts it with `qpdf --encrypt … 256`,
runs the exact MuPDF open→authenticate→`saveToBuffer("decrypt=yes")` path, and asserts the
output is no longer encrypted (`qpdf --is-encrypted` exits nonzero) and still valid
(`qpdf --check`). `node_modules` and `qpdf` are dev-only — neither ships to production.

---

## 6. Interface Contract (main thread ⇄ worker)

This `postMessage` contract is the single integration boundary between the UI and the engine;
each side is implemented and tested against it independently.

**Main thread → worker**
```js
{ type: "decrypt", buffer: ArrayBuffer, password: string, name: string }   // buffer transferred
```

**Worker → main thread**
```js
{ type: "ready" }                                  // wasm initialized; UI may enable
{ type: "needPassword" }                           // encrypted + missing/wrong password
{ type: "success", buffer: ArrayBuffer, name: string }   // decrypted bytes (transferred) + download name
{ type: "error", message: string }                 // corrupt/unsupported/other failure
```

- `name` (inbound) is the original filename; the worker derives the output name by stripping a
  trailing `.pdf` (case-insensitive) and appending `-unlocked.pdf` (e.g. `report.pdf` →
  `report-unlocked.pdf`).
- `ArrayBuffer`s are passed as **transferables** (zero-copy ownership move), so the buffer is
  neutered on the sender side after posting.

---

## 7. Primary Flow — "Remove password"

```
User drops/selects PDF ─► app.js validates (MIME or .pdf) ─► enables button
        │
User clicks "Remove password"
        │
app.js: File.arrayBuffer() ─► postMessage({decrypt, buffer, password, name}, [buffer])
        │                       (UI → "Working…", button disabled)
        ▼
worker.js: openDocument
        ├─ needsPassword() && (empty || auth fails) ─► postMessage({needPassword})
        │        └─► app.js: focus password field, show first-time vs wrong-password hint
        │
        ├─ auth ok ─► saveToBuffer("decrypt=yes") ─► postMessage({success, buffer, name}, [buffer])
        │        └─► app.js: Blob → object URL → auto-download → revoke URL
        │
        └─ throws ─► postMessage({error, message})
                 └─► app.js: show error state
```

State note: `app.js` tracks whether a non-empty password was sent (`triedPassword`) so it can
distinguish "this PDF is protected, enter the password" from "that password was wrong."

---

## 8. Security & Privacy Model

- **Data never leaves the device.** No `fetch`/`XHR`/upload of user content exists in the
  code path; bytes live only in the tab's memory and are handed to the worker via transfer.
- **No persistence.** Nothing is written to storage; the result object URL is revoked after
  download.
- **No third-party runtime calls.** The engine is vendored; there are no CDN/font/analytics
  requests, so nothing observes usage.
- **Trust surface** is limited to (a) the static host serving unmodified files over HTTPS and
  (b) the MuPDF wasm binary. Both are auditable; the wasm is version-pinned at 1.27.0.
- **Threat note:** because everything is client-side, there is no server attack surface for
  the documents themselves. A compromised host could serve malicious JS — mitigated by HTTPS,
  pinned vendored assets, and the option to self-host or run locally.

---

## 9. Deployment & Operations

- **Host:** GitHub Pages (free). Repo root *is* the site; the Actions workflow publishes it.
  No headers/config required because the single-threaded wasm build avoids
  `SharedArrayBuffer` (D5).
- **Serving requirements:** assets must be served over `http(s)` (not `file://`) for the
  module worker + wasm to load; `.wasm` must be sent as `application/wasm` (GitHub Pages and
  Python's `http.server` both do this).
- **Local dev:** `python3 -m http.server 8000`.
- **Cost & scaling:** effectively zero — static CDN delivery; compute is the user's. There is
  no per-request server cost regardless of traffic.

---

## 10. Verification Strategy

| Layer | Method | Evidence |
|-------|--------|----------|
| Engine correctness | `node test/decrypt.test.mjs` — qpdf-encrypted fixture, independent `qpdf --is-encrypted`/`--check` cross-check | Output confirmed decrypted & valid |
| Static delivery | Local `http.server` + `curl` of every asset | All 200; `.wasm` = `application/wasm`; no `node_modules` refs in shipped files |
| Full pipeline | Headless Chromium loading the real page + worker against the encrypted fixture | Worker `ready`, wasm loaded, output `%PDF-…`, correct `-unlocked.pdf` name |

---

## 11. Known Limitations & Future Work

- **Known-password only** — cannot recover/crack an unknown password (by design).
- **Large wasm payload (~10 MB)** on first load; served compressed (gzip/brotli) by the host
  and browser-cached thereafter. A Service Worker could cache it for full offline use.
- **Owner-only restricted PDFs** (no user password) simply open and re-save unrestricted.
- **Memory-bound** by the device for very large PDFs (entire file held in RAM).
- **License obligation:** MuPDF is AGPL (Artifex). Redistribution must comply; a commercial
  license is an alternative. The app's own code is MIT (`LICENSE`, `package.json`, and README
  all aligned).

---

## 12. Project Structure

```
index.html                     UI markup
styles.css                     styling
app.js                         main-thread controller
worker.js                      decryption Web Worker
vendor/mupdf/                  vendored MuPDF 1.27 (mupdf.js, mupdf-wasm.js, .wasm)
test/decrypt.test.mjs          dev-only Node test (uses qpdf)
.github/workflows/deploy.yml   GitHub Pages deploy
.nojekyll                      serve vendor/ verbatim
README.md / ARCHITECTURE.md    docs
.gitignore                     excludes node_modules/, test/tmp/, scratch PDFs
```

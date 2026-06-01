# CLAUDE.md

Guidance for working in this repo in future sessions.

## What this is
A **fully client-side, static** website that removes the password from a PDF. The user
supplies a password they know; the app decrypts and re-saves the PDF without encryption.
**It does NOT crack/recover unknown passwords** — decryption requires the correct password.

All processing happens in the browser via **MuPDF compiled to WebAssembly**. The PDF never
leaves the device. There is **no backend, no build step, no bundler** — files are served
verbatim. See `ARCHITECTURE.md` for the full design.

## Stack & layout
- Plain ES modules + a Web Worker. No framework, no transpile.
- `index.html` / `styles.css` / `app.js` — UI (main thread controller).
- `worker.js` — module Web Worker that does the decrypt.
- `vendor/mupdf/` — **vendored** MuPDF 1.27.0 (`mupdf.js`, `mupdf-wasm.js`, `mupdf-wasm.wasm`,
  plus a `package.json` `{"type":"module"}`). This is the runtime engine. `node_modules/` is
  dev-only and is NOT shipped/committed.
- `test/decrypt.test.mjs` — Node test (dev-only; uses the `qpdf` CLI).
- `.github/workflows/deploy.yml`, `.nojekyll` — GitHub Pages deploy.

## The one critical engine gotcha
MuPDF's `doc.saveToBuffer("")` **PRESERVES the original encryption**. To actually strip the
password you MUST use `doc.saveToBuffer("decrypt=yes")`. This is non-obvious and was only
caught via a `qpdf --is-encrypted` cross-check. Both `worker.js` and the test use
`"decrypt=yes"`. Do not "simplify" it back to `""`.

Other MuPDF notes (v1.27):
- `mupdf.js` does a top-level `await` to init wasm; in a `type:"module"` worker the engine is
  ready right after `import` resolves (worker posts `{type:"ready"}` then).
- `mupdf-wasm.js` finds the binary via `new URL("mupdf-wasm.wasm", import.meta.url)` — all
  three vendored files must stay in the same directory.
- API path: `Document.openDocument(Uint8Array, "application/pdf")` → `needsPassword()` →
  `authenticatePassword(pw)` (nonzero = success) → `saveToBuffer("decrypt=yes")`.

## Worker ⇄ UI contract (the integration boundary — keep both sides in sync)
Main → worker: `{ type:"decrypt", buffer:ArrayBuffer, password:string, name:string }` (buffer transferred).
Worker → main:
- `{ type:"ready" }`
- `{ type:"needPassword" }` (encrypted + empty/wrong password)
- `{ type:"success", buffer:ArrayBuffer, name:string }` (buffer transferred; name = original with `.pdf` stripped + `-unlocked.pdf`)
- `{ type:"error", message:string }`

## How to run / test
- **Local dev:** `python3 -m http.server 8000` then open `http://localhost:8000`.
  MUST be served over http — `file://` breaks the module worker + wasm.
- **Engine test:** `node test/decrypt.test.mjs` (generates a fixture, encrypts with qpdf,
  decrypts via vendored mupdf, asserts the output is not encrypted and is valid). Scratch
  PDFs land in `test/tmp/` (gitignored).
- **Headless browser smoke test** (full pipeline): the only browser here is the snap
  `/snap/bin/chromium`. Snap confinement blocks a `--user-data-dir` under `/tmp` (Chromium
  silently won't start) — create the profile dir INSIDE the project instead, e.g.
  `mktemp -d ./.chr.XXXX`. `--dump-dom` snapshots before Web Worker async work finishes;
  to capture an async result, have the test page beacon it via `fetch("/__result__?r=...")`
  and read the static server's access log.

## Deploy (GitHub Pages, free)
`git init && commit`, push to GitHub, then Settings → Pages → Source: **GitHub Actions**. The
workflow publishes the repo root (no build/install). No COOP/COEP headers needed because the
wasm build is single-threaded (no SharedArrayBuffer). Site URL: `https://USER.github.io/REPO/`.
`.wasm` must be served as `application/wasm` (GH Pages + python http.server both do).

## Conventions / constraints
- Keep it dependency-free at runtime and build-step-free. Don't introduce a bundler or pull
  MuPDF from a CDN — it's deliberately vendored for offline use and supply-chain safety.
- To upgrade MuPDF: `npm install mupdf@<ver>`, then re-copy the three dist files into
  `vendor/mupdf/` (do NOT copy the `.br` or `.d.ts` files), and re-run the test.
- This is not yet a git repo (no `.git`). Only branch/commit/push when the user asks.

## Open items
- MuPDF is AGPL (Artifex); honor it for redistribution (or use a commercial license).

## Conventions for git commits
- Do NOT add a `Co-Authored-By` trailer (or any Claude/AI attribution) to commit messages.

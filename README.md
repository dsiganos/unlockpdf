# UnlockPDF

Remove a known password from a PDF, entirely in your browser.

**100% private:** files are processed entirely in your browser via WebAssembly
(MuPDF) and never uploaded to any server. There is no backend — the whole site
is static files.

## What it does

You give it a password-protected PDF **and its password**, and it produces a new
PDF that opens freely without a password.

> **Important:** you must **know** the password. This tool removes a *known*
> password so the PDF opens without prompting — it does **not** crack, guess, or
> recover unknown passwords.

## Run it locally

Because the app uses a JavaScript module worker and WebAssembly, it must be
**served over HTTP** — opening `index.html` directly as a `file://` URL will not
work.

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploy to GitHub Pages

This project lives at **<https://github.com/dsiganos/unlockpdf>**.

1. Open the repo's
   [**Settings → Pages**](https://github.com/dsiganos/unlockpdf/settings/pages)
   and set the **Source** to **GitHub Actions**.
2. That's it — the included workflow (`.github/workflows/deploy.yml`) builds and
   deploys on every push to `main`/`master` (and can be run manually via
   *Run workflow* on the
   [Actions tab](https://github.com/dsiganos/unlockpdf/actions)).

Once enabled, the site is served at:

```
https://dsiganos.github.io/unlockpdf/
```

A custom domain (`unlockpdf.app`) can be attached under **Settings → Pages →
Custom domain** once registered.

A `.nojekyll` file is included so GitHub Pages serves the `vendor/` directory
and all files verbatim (Jekyll is disabled).

## Project structure

```
index.html               # UI
styles.css               # Styles
app.js                   # Main-thread app logic
worker.js                # Module worker that runs MuPDF off the main thread
vendor/mupdf/            # Vendored MuPDF WebAssembly library
  mupdf.js
  mupdf-wasm.js
  mupdf-wasm.wasm
test/                    # Node-based dev tests (not deployed)
.github/workflows/       # GitHub Pages deploy workflow
.nojekyll                # Disable Jekyll on GitHub Pages
```

## Tech

MuPDF WASM, no build step, no dependencies at runtime. The MuPDF library is
vendored under `vendor/mupdf/`, so the deployed site needs nothing installed.

## Dev test

A Node-based test exercises the decryption logic:

```sh
node test/decrypt.test.mjs
```

## License

This project's own code is licensed under the **MIT License**.

MuPDF (vendored under `vendor/mupdf/`) is a separate work licensed by
**Artifex Software** under the **GNU AGPL** (with a commercial license also
available). If you redistribute this project, please review and comply with
MuPDF's license terms: <https://mupdf.com/licensing>.

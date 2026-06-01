// worker.js — PDF password-remover web worker (ES MODULE worker)
//
// Run as: new Worker("./worker.js", { type: "module" })
//
// =========================================================================
// MESSAGE CONTRACT (shared with the UI / main thread)
// =========================================================================
//
// Inbound  (main thread -> worker), via postMessage:
//   { type: "decrypt", buffer: ArrayBuffer, password: string, name: string }
//     - buffer:   the raw bytes of the (possibly encrypted) PDF
//     - password: the password to try (use "" when the user has not entered one)
//     - name:     the ORIGINAL filename (e.g. "secret.pdf"). The worker computes
//                 the output filename from this: it strips a trailing ".pdf"
//                 (case-insensitively) and appends "-unlocked.pdf".
//                 e.g. "Secret.PDF" -> "Secret-unlocked.pdf"
//                      "report"     -> "report-unlocked.pdf"
//
// Outbound (worker -> main thread), via postMessage:
//   { type: "ready" }
//       posted once, as soon as the mupdf wasm module is loaded/usable.
//   { type: "needPassword" }
//       the file is encrypted and the supplied password is missing or wrong.
//       The UI should prompt for a (new) password and re-send "decrypt".
//   { type: "success", buffer: ArrayBuffer, name: string }
//       decrypted PDF bytes. `buffer` is TRANSFERRED (zero-copy), so the
//       worker no longer owns it after posting. `name` is the output filename
//       described above.
//   { type: "error", message: string }
//       any failure (corrupt / unsupported / unexpected). `message` is a string.
//
// =========================================================================
// mupdf initialization model (v1.27.0)
// =========================================================================
// vendor/mupdf/mupdf.js performs a TOP-LEVEL `await` on the wasm module
// (`const libmupdf = await libmupdf_wasm(...)`). Because this worker is a
// *module* worker, the static `import` below does not resolve until that
// top-level await completes — i.e. by the time module evaluation continues
// past the import, the wasm context is already initialized. So we can safely
// post {type:"ready"} immediately after import.
//
// The .wasm file is located by mupdf-wasm.js via
// `new URL("mupdf-wasm.wasm", import.meta.url)`, so all three vendored files
// MUST live in the same directory (vendor/mupdf/).

import * as mupdf from "./vendor/mupdf/mupdf.js";

// The import above already awaited wasm init — announce readiness.
postMessage({ type: "ready" });

/**
 * Derive the output filename from the original name:
 * strip a trailing ".pdf" (case-insensitive), then append "-unlocked.pdf".
 * @param {string} name
 * @returns {string}
 */
function unlockedName(name) {
	const base = (typeof name === "string" && name.length > 0) ? name : "document.pdf";
	const stripped = base.replace(/\.pdf$/i, "");
	return `${stripped}-unlocked.pdf`;
}

/**
 * Best-effort free of a mupdf Userdata object. v1.27 exposes .destroy();
 * guard so we never throw if the API changes.
 * @param {{ destroy?: () => void } | null | undefined} obj
 */
function freeObject(obj) {
	try {
		if (obj && typeof obj.destroy === "function") {
			obj.destroy();
		}
	} catch {
		// Ignore — freeing is best-effort and must never mask a real result.
	}
}

self.onmessage = (event) => {
	const msg = event.data;
	if (!msg || msg.type !== "decrypt") {
		return;
	}

	const { buffer, password, name } = msg;
	const outName = unlockedName(name);

	let doc = null;
	let outBuffer = null;
	try {
		// Open the document. openDocument accepts a Uint8Array view of the bytes.
		doc = mupdf.Document.openDocument(new Uint8Array(buffer), "application/pdf");

		// If the document is encrypted we must authenticate before saving.
		if (doc.needsPassword()) {
			if (!password) {
				// Encrypted but the user gave no password — ask for one.
				postMessage({ type: "needPassword" });
				return;
			}
			// authenticatePassword returns a nonzero (truthy) code on success.
			const auth = doc.authenticatePassword(password);
			if (!auth) {
				// Wrong password — ask again.
				postMessage({ type: "needPassword" });
				return;
			}
		}

		// Save the PDF to a buffer, explicitly stripping encryption.
		// mupdf's "decrypt=yes" write option removes the existing encryption
		// so the output is a plain, unprotected PDF. (Saving with default
		// options would otherwise preserve the original encryption.)
		outBuffer = doc.saveToBuffer("decrypt=yes");
		const out = outBuffer.asUint8Array();

		// Copy out of wasm memory into a standalone ArrayBuffer we can transfer.
		// `out` is a view onto wasm heap; slice() gives us an owned copy.
		const owned = out.slice();

		postMessage(
			{ type: "success", buffer: owned.buffer, name: outName },
			[owned.buffer]
		);
	} catch (err) {
		postMessage({ type: "error", message: String(err) });
	} finally {
		// Free wasm-side objects (best effort).
		freeObject(outBuffer);
		freeObject(doc);
	}
};

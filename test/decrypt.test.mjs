// test/decrypt.test.mjs
//
// Node ESM test for the PDF decrypt routine used by worker.js.
//
// Run with:  node test/decrypt.test.mjs
//
// Because the worker communicates via postMessage, we cannot import its
// handler directly without a DOM/Worker environment. Instead this test
// imports mupdf from the SAME vendored path the worker uses and replicates
// the open -> needsPassword -> authenticate -> saveToBuffer steps, asserting
// the same behavior the worker relies on. We additionally cross-check the
// result with the `qpdf` CLI.
//
// Steps:
//   1. Generate a minimal valid PDF (python heredoc), assert `qpdf --check`.
//   2. Encrypt it with AES-256 via `qpdf --encrypt ...`.
//   3. (a) open encrypted WITHOUT auth  -> needsPassword() === true
//      (b) wrong password               -> authenticatePassword() falsy
//      (c) correct password             -> authenticatePassword() truthy,
//          saveToBuffer("decrypt=yes") yields bytes
//   4. Write decrypted bytes to unlocked.pdf and assert:
//          `qpdf --is-encrypted unlocked.pdf` exits NONZERO (not encrypted)
//          `qpdf --check unlocked.pdf` passes (exit 0)

import * as mupdf from "../vendor/mupdf/mupdf.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = join(__dirname, "tmp");

const USER_PW = "user-secret-123";
const OWNER_PW = "owner-secret-456";
const WRONG_PW = "definitely-not-the-password";

let failures = 0;

function pass(label) {
	console.log(`PASS: ${label}`);
}
function fail(label, detail) {
	failures++;
	console.error(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
}
function assert(cond, label, detail) {
	if (cond) pass(label);
	else fail(label, detail);
}

/** Run a command, returning { code, stdout, stderr }. Never throws. */
function run(cmd, args) {
	try {
		const stdout = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { code: 0, stdout, stderr: "" };
	} catch (e) {
		return {
			code: typeof e.status === "number" ? e.status : 1,
			stdout: e.stdout ? String(e.stdout) : "",
			stderr: e.stderr ? String(e.stderr) : String(e),
		};
	}
}

// ---------------------------------------------------------------------------
// Setup: fresh tmp dir
// ---------------------------------------------------------------------------
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const plainPath = join(TMP, "plain.pdf");
const encryptedPath = join(TMP, "encrypted.pdf");
const unlockedPath = join(TMP, "unlocked.pdf");

// ---------------------------------------------------------------------------
// 1. Generate a minimal valid PDF via python (correct xref offsets).
// ---------------------------------------------------------------------------
const pyGen = `
import struct, sys

objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    None,  # content stream, filled below
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
stream = b"BT /F1 24 Tf 72 700 Td (Hello, world!) Tj ET"
objs[3] = b"<< /Length " + str(len(stream)).encode() + b" >>\\nstream\\n" + stream + b"\\nendstream"

out = bytearray()
out += b"%PDF-1.7\\n%\\xe2\\xe3\\xcf\\xd3\\n"
offsets = []
for i, body in enumerate(objs, start=1):
    offsets.append(len(out))
    out += str(i).encode() + b" 0 obj\\n" + body + b"\\nendobj\\n"

xref_pos = len(out)
n = len(objs) + 1
out += b"xref\\n0 " + str(n).encode() + b"\\n"
out += b"0000000000 65535 f \\n"
for off in offsets:
    out += ("%010d 00000 n \\n" % off).encode()
out += b"trailer\\n<< /Size " + str(n).encode() + b" /Root 1 0 R >>\\n"
out += b"startxref\\n" + str(xref_pos).encode() + b"\\n%%EOF\\n"

with open(sys.argv[1], "wb") as f:
    f.write(out)
`;

run("python3", ["-c", pyGen, plainPath]);
{
	const r = run("qpdf", ["--check", plainPath]);
	assert(r.code === 0, "generated plain.pdf passes `qpdf --check`", r.stderr || r.stdout);
}

// ---------------------------------------------------------------------------
// 2. Encrypt with AES-256.
// ---------------------------------------------------------------------------
{
	const r = run("qpdf", ["--encrypt", USER_PW, OWNER_PW, "256", "--", plainPath, encryptedPath]);
	assert(r.code === 0, "qpdf encrypted plain.pdf -> encrypted.pdf", r.stderr || r.stdout);

	const enc = run("qpdf", ["--is-encrypted", encryptedPath]);
	assert(enc.code === 0, "qpdf reports encrypted.pdf IS encrypted", `exit ${enc.code}`);
}

const encryptedBytes = readFileSync(encryptedPath);

// ---------------------------------------------------------------------------
// 3a. Open encrypted WITHOUT auth -> needsPassword() === true
// ---------------------------------------------------------------------------
{
	let doc = null;
	try {
		doc = mupdf.Document.openDocument(new Uint8Array(encryptedBytes), "application/pdf");
		assert(doc.needsPassword() === true, "mupdf: encrypted doc reports needsPassword() === true");
	} catch (e) {
		fail("mupdf: open encrypted doc without auth", String(e));
	} finally {
		if (doc && typeof doc.destroy === "function") doc.destroy();
	}
}

// ---------------------------------------------------------------------------
// 3b. Wrong password -> authenticatePassword() falsy
// ---------------------------------------------------------------------------
{
	let doc = null;
	try {
		doc = mupdf.Document.openDocument(new Uint8Array(encryptedBytes), "application/pdf");
		const auth = doc.authenticatePassword(WRONG_PW);
		assert(!auth, "mupdf: wrong password fails to authenticate", `auth=${auth}`);
	} catch (e) {
		fail("mupdf: wrong-password auth attempt", String(e));
	} finally {
		if (doc && typeof doc.destroy === "function") doc.destroy();
	}
}

// ---------------------------------------------------------------------------
// 3c. Correct password -> auth truthy + saveToBuffer yields bytes
// ---------------------------------------------------------------------------
let decryptedBytes = null;
{
	let doc = null;
	let buf = null;
	try {
		doc = mupdf.Document.openDocument(new Uint8Array(encryptedBytes), "application/pdf");
		const auth = doc.authenticatePassword(USER_PW);
		assert(!!auth, "mupdf: correct password authenticates", `auth=${auth}`);

		// Same option string the worker uses — strips encryption.
		buf = doc.saveToBuffer("decrypt=yes");
		const out = buf.asUint8Array();
		assert(out.length > 0, "mupdf: saveToBuffer('decrypt=yes') yields non-empty bytes", `len=${out.length}`);
		decryptedBytes = Buffer.from(out.slice());
	} catch (e) {
		fail("mupdf: correct-password decrypt + save", String(e));
	} finally {
		if (buf && typeof buf.destroy === "function") buf.destroy();
		if (doc && typeof doc.destroy === "function") doc.destroy();
	}
}

// ---------------------------------------------------------------------------
// 3d. Write unlocked.pdf and cross-check with qpdf.
// ---------------------------------------------------------------------------
if (decryptedBytes) {
	writeFileSync(unlockedPath, decryptedBytes);

	const isEnc = run("qpdf", ["--is-encrypted", unlockedPath]);
	// `--is-encrypted` exits 0 if encrypted, nonzero if NOT encrypted.
	assert(isEnc.code !== 0, "qpdf: unlocked.pdf is NOT encrypted (--is-encrypted exits nonzero)", `exit ${isEnc.code}`);

	const check = run("qpdf", ["--check", unlockedPath]);
	assert(check.code === 0, "qpdf: unlocked.pdf passes `qpdf --check`", check.stderr || check.stdout);
} else {
	fail("decrypted bytes available for qpdf cross-check", "no bytes were produced");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
	console.error(`\n${failures} assertion(s) FAILED`);
	process.exit(1);
} else {
	console.log("\nAll assertions PASSED");
	process.exit(0);
}

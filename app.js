// ---------------------------------------------------------------------------
// UnlockPDF — UI controller (ES module)
//
// Talks to the MuPDF web worker ONLY via the agreed postMessage contract:
//   -> { type: "decrypt", buffer, password, name } (buffer transferred)
//   <- { type: "ready" }        wasm ready -> enable UI
//   <- { type: "needPassword" } encrypted + empty/wrong password
//   <- { type: "success", buffer, name } decrypted bytes + filename
//   <- { type: "error", message }
// ---------------------------------------------------------------------------

// --- Element references ----------------------------------------------------
const dropzone      = document.getElementById("dropzone");
const fileInput     = document.getElementById("fileInput");
const fileMeta      = document.getElementById("fileMeta");
const passwordInput = document.getElementById("passwordInput");
const togglePassword= document.getElementById("togglePassword");
const removeBtn     = document.getElementById("removeBtn");
const statusEl      = document.getElementById("status");

// --- State -----------------------------------------------------------------
let selectedFile = null;   // currently chosen File
let workerReady  = false;  // becomes true after worker says { type: "ready" }
let inFlight     = false;  // a decrypt job is currently running
let triedPassword = false; // whether the last job supplied a non-empty password

// --- Worker setup ----------------------------------------------------------
const worker = new Worker("./worker.js", { type: "module" });

worker.onmessage = (e) => {
  const msg = e.data || {};
  switch (msg.type) {
    case "ready":
      workerReady = true;
      updateButtonState();
      break;
    case "needPassword":
      handleNeedPassword();
      break;
    case "success":
      handleSuccess(msg.buffer, msg.name);
      break;
    case "error":
      finishJob();
      setStatus("error", msg.message || "Something went wrong while processing the PDF.");
      break;
    default:
      // Unknown message types are ignored to stay forward-compatible.
      break;
  }
};

worker.onerror = (err) => {
  finishJob();
  setStatus("error", "The PDF engine failed to load: " + (err.message || "unknown error") + ".");
};

// --- Status helpers --------------------------------------------------------
/**
 * Render a status message.
 * @param {"info"|"success"|"error"|"warn"} kind
 * @param {string} text
 * @param {boolean} [withSpinner]
 */
function setStatus(kind, text, withSpinner = false) {
  statusEl.hidden = false;
  statusEl.className = "status " + kind;
  statusEl.textContent = "";
  if (withSpinner) {
    const spin = document.createElement("span");
    spin.className = "spinner";
    statusEl.appendChild(spin);
  }
  statusEl.appendChild(document.createTextNode(text));
}

function clearStatus() {
  statusEl.hidden = true;
  statusEl.className = "status";
  statusEl.textContent = "";
}

// --- File handling ---------------------------------------------------------
function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return value.toFixed(value < 10 ? 1 : 0) + " " + units[i];
}

function selectFile(file) {
  if (!file) return;
  if (!isPdf(file)) {
    selectedFile = null;
    fileMeta.hidden = true;
    setStatus("error", "That doesn't look like a PDF. Please choose a .pdf file.");
    updateButtonState();
    return;
  }
  selectedFile = file;
  fileMeta.hidden = false;
  fileMeta.textContent = `${file.name} — ${formatSize(file.size)}`;
  clearStatus();
  updateButtonState();
}

// --- Button / enabled state ------------------------------------------------
function updateButtonState() {
  removeBtn.disabled = !(workerReady && selectedFile && !inFlight);
}

// --- Job lifecycle ---------------------------------------------------------
async function startJob() {
  if (!selectedFile || !workerReady || inFlight) return;

  inFlight = true;
  triedPassword = passwordInput.value.length > 0;
  updateButtonState();
  setStatus("info", "Working… removing the password. This can take a few seconds.", true);

  let buffer;
  try {
    // Read the File into an ArrayBuffer so it can be transferred to the worker.
    buffer = await selectedFile.arrayBuffer();
  } catch (err) {
    finishJob();
    setStatus("error", "Couldn't read the file: " + (err.message || "unknown error") + ".");
    return;
  }

  // Transfer the buffer (zero-copy) to the worker per the contract.
  worker.postMessage(
    { type: "decrypt", buffer, password: passwordInput.value, name: selectedFile.name },
    [buffer]
  );
}

function finishJob() {
  inFlight = false;
  updateButtonState();
}

function handleNeedPassword() {
  finishJob();
  if (triedPassword) {
    // A password was supplied but it was wrong.
    setStatus("warn", "That password didn't work. Please re-enter the correct password and try again.");
  } else {
    // Encrypted file, no password supplied yet.
    setStatus("warn", "This PDF is password-protected. Enter its password, then press “Remove password”.");
  }
  passwordInput.focus();
  passwordInput.select();
}

function handleSuccess(buffer, name) {
  finishJob();

  // Build a download for the decrypted PDF bytes.
  const blob = new Blob([buffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const downloadName = name || "unlocked.pdf";

  // Trigger the download automatically.
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName;
  document.body.appendChild(a);
  a.click();
  a.remove();

  // Show success state with an explicit Download button as a fallback,
  // then revoke the URL once it's no longer needed.
  setStatus("success", "Done! Your password-free PDF has downloaded. ");
  const dl = document.createElement("button");
  dl.type = "button";
  dl.className = "download-btn";
  dl.textContent = "Download again";
  dl.addEventListener("click", () => {
    const a2 = document.createElement("a");
    a2.href = url;
    a2.download = downloadName;
    document.body.appendChild(a2);
    a2.click();
    a2.remove();
  });
  statusEl.appendChild(document.createElement("br"));
  statusEl.appendChild(dl);

  // Revoke after a delay so both the auto-download and a quick manual
  // re-download still work. The Blob keeps the data alive until then.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// --- Event wiring ----------------------------------------------------------

// Dropzone click + keyboard open the hidden file picker.
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

// Picker change.
fileInput.addEventListener("change", () => {
  selectFile(fileInput.files[0]);
});

// Drag-over styling + drop handling.
["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "dragend", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) selectFile(file);
});

// Show/hide password toggle.
togglePassword.addEventListener("click", () => {
  const show = passwordInput.type === "password";
  passwordInput.type = show ? "text" : "password";
  togglePassword.textContent = show ? "Hide" : "Show";
  togglePassword.setAttribute("aria-pressed", String(show));
  passwordInput.focus();
});

// Primary action.
removeBtn.addEventListener("click", startJob);

// Pressing Enter in the password field submits when ready.
passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !removeBtn.disabled) startJob();
});

// Initial status while the wasm engine loads.
setStatus("info", "Loading the PDF engine…", true);

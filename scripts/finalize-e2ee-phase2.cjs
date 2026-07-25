const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");

function replaceRequired(content, before, after, label) {
  if (!content.includes(before)) throw new Error(`Unable to patch ${label}.`);
  return content.replace(before, after);
}

async function patchBrowserRuntime() {
  const runtimePath = path.join(root, "public", "assets", "e2ee-phase2.js");
  let runtime = await fs.readFile(runtimePath, "utf8");

  runtime = replaceRequired(
    runtime,
    `        if (!db.objectStoreNames.contains("devices")) db.createObjectStore("devices");
        if (!db.objectStoreNames.contains("trust")) db.createObjectStore("trust", { keyPath: "key" });`,
    `        if (db.objectStoreNames.contains("devices")) {
          const existingDevices = request.transaction.objectStore("devices");
          if (existingDevices.keyPath !== null) {
            db.deleteObjectStore("devices");
            db.createObjectStore("devices");
          }
        } else {
          db.createObjectStore("devices");
        }
        if (!db.objectStoreNames.contains("trust")) db.createObjectStore("trust", { keyPath: "key" });`,
    "legacy IndexedDB device-store migration"
  );

  runtime = replaceRequired(
    runtime,
    `  function messageIdFromAad(value) {
    const parts = String(value || "").split("|");
    return parts.length === 7 && parts[0] === ALGORITHM && parts[1] === "content" ? parts[4] : "";
  }`,
    `  function messageIdFromAad(value) {
    const parts = String(value || "").split("|");
    if (parts[0] !== ALGORITHM || parts[1] !== "content") return "";
    if (parts.length === 7 && /^v[12]$/.test(parts[2])) return parts[4];
    // Phase 1 used algorithm|content|chat|message|device.
    if (parts.length === 5) return parts[3];
    return "";
  }`,
    "phase 1 associated-data compatibility"
  );

  runtime = replaceRequired(
    runtime,
    `  async function verifyAttachmentManifest(actualAttachments, expectedManifest) {
    const actual = await attachmentManifest(actualAttachments);
    const expected = Array.isArray(expectedManifest) ? expectedManifest : [];
    if (actual.length !== expected.length) return false;
    return actual.every((item, index) => (
      item.kind === String(expected[index]?.kind || "")
      && item.name === String(expected[index]?.name || "")
      && item.mime === String(expected[index]?.mime || "")
      && item.size === Number(expected[index]?.size || 0)
      && item.digest === String(expected[index]?.digest || "")
    ));
  }`,
    `  async function verifyAttachmentManifest(actualAttachments, expectedManifest, e2eeVersion) {
    const actual = await attachmentManifest(actualAttachments);
    const expected = Array.isArray(expectedManifest) ? expectedManifest : [];
    if (actual.length !== expected.length) return false;
    return actual.every((item, index) => {
      const expectedItem = expected[index] || {};
      const baseMatches = item.kind === String(expectedItem.kind || "")
        && item.name === String(expectedItem.name || "")
        && item.mime === String(expectedItem.mime || "")
        && item.size === Number(expectedItem.size || 0);
      // Phase 1 authenticated only the manifest fields. Phase 2 also binds
      // the actual attachment source to the encrypted digest.
      return baseMatches && (Number(e2eeVersion) === 1 || item.digest === String(expectedItem.digest || ""));
    });
  }`,
    "phase 1 attachment-manifest compatibility"
  );

  runtime = replaceRequired(
    runtime,
    `      if (!await verifyAttachmentManifest(message.attachments, plaintext.attachments)) {`,
    `      if (!await verifyAttachmentManifest(message.attachments, plaintext.attachments, e2ee.version)) {`,
    "versioned attachment verification"
  );

  const required = [
    'const PROTOCOL_VERSION = 2;',
    '"server-blind-text-v1"',
    'privateVault: await encryptPrivateVault(value)',
    'if (key.extractable !== false)',
    'rolloutPhase === "encrypted"',
    'text: "",',
    'replyToMessageId: null,',
    'New protected message'.replace("New protected message", "Новое защищённое сообщение")
  ];
  required.forEach((marker) => {
    if (!runtime.includes(marker)) throw new Error(`Missing E2EE phase 2 runtime marker: ${marker}`);
  });

  const forbidden = [
    'PUSH_DEVICE_ID_KEY',
    'createObjectStore("cryptoKeys")',
    '/assets/e2ee-runtime.js'
  ];
  forbidden.forEach((marker) => {
    if (runtime.includes(marker)) throw new Error(`Unsafe legacy E2EE marker remains: ${marker}`);
  });

  await fs.writeFile(runtimePath, runtime, "utf8");
  await execFileAsync(process.execPath, ["--check", runtimePath]);
}

async function patchServerCompatibility() {
  const serverPath = path.join(root, "server", "e2ee.py");
  let source = await fs.readFile(serverPath, "utf8");

  source = replaceRequired(
    source,
    `    aad = _text(raw.get("aad"), 900)
    if aad != expected_aad:
        raise HTTPException(status_code=400, detail="E2EE associated data does not match the message context.")`,
    `    aad = _text(raw.get("aad"), 900)
    legacy_shadow_aad = f"{_ALGORITHM}|content|{chat_id}|{message_id}|{sender_device_id}"
    accepted_legacy_shadow = mode == "shadow" and version == 1 and aad == legacy_shadow_aad
    if aad != expected_aad and not accepted_legacy_shadow:
        raise HTTPException(status_code=400, detail="E2EE associated data does not match the message context.")`,
    "phase 1 server AAD compatibility"
  );

  if (!source.includes("accepted_legacy_shadow") || !source.includes('mode == "encrypted" and version < 2')) {
    throw new Error("Server E2EE version compatibility is incomplete.");
  }
  await fs.writeFile(serverPath, source, "utf8");
}

async function main() {
  await patchBrowserRuntime();
  await patchServerCompatibility();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

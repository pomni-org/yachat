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

function replaceAllRequired(content, before, after, expectedCount, label) {
  const count = content.split(before).length - 1;
  if (count !== expectedCount) {
    throw new Error(`Unable to patch ${label}: expected ${expectedCount}, found ${count}.`);
  }
  return content.split(before).join(after);
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
    `    const allowed = new Set(["STRONG", "EM", "U", "S", "CODE", "BR", "A"]);
    const output = document.createElement("div");`,
    `    const allowed = new Set(["STRONG", "EM", "U", "S", "CODE", "BR", "A"]);
    const blocked = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH"]);
    const output = document.createElement("div");`,
    "blocked rich-content elements"
  );

  runtime = replaceRequired(
    runtime,
    `      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName === "B" ? "STRONG" : node.tagName === "I" ? "EM" : node.tagName === "DEL" ? "S" : node.tagName;`,
    `      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (blocked.has(node.tagName)) return;
      const tag = node.tagName === "B" ? "STRONG" : node.tagName === "I" ? "EM" : node.tagName === "DEL" ? "S" : node.tagName;`,
    "drop active rich-content subtrees"
  );

  runtime = replaceRequired(
    runtime,
    `  const MAX_LOCAL_PREKEYS = 220;`,
    `  // Phase 2 retains historical private prekeys. Until Double Ratchet
  // persists independent session state, deleting them would make old messages unreadable.`,
    "historical prekey retention policy"
  );

  runtime = replaceRequired(
    runtime,
    `    record.signedPreKeys = signed.slice(-4);`,
    `    record.signedPreKeys = signed;`,
    "historical signed-prekey retention"
  );

  runtime = replaceRequired(
    runtime,
    `    if (record.oneTimePreKeys.length > MAX_LOCAL_PREKEYS) {
      record.oneTimePreKeys = record.oneTimePreKeys.slice(-MAX_LOCAL_PREKEYS);
    }
`,
    ``,
    "refresh one-time prekey truncation"
  );

  runtime = replaceAllRequired(
    runtime,
    `      if (record.oneTimePreKeys.length > MAX_LOCAL_PREKEYS) record.oneTimePreKeys = record.oneTimePreKeys.slice(-MAX_LOCAL_PREKEYS);
`,
    ``,
    2,
    "registration one-time prekey truncation"
  );

  const required = [
    'const PROTOCOL_VERSION = 5;',
    '"server-blind-text-v1"',
    '"encrypted-attachments-v1"',
    '"encrypted-push-preview-v1"',
    '"mandatory-e2ee-v1"',
    '"signed-messages-v1"',
    '"padded-content-v1"',
    '"sealed-push-descriptor-v1"',
    '"encrypted-digital-id-v1"',
    'const DB_VERSION = 7;',
    'createObjectStore("pushPreviewKeys"',
    'createObjectStore("pushPreviewTrust"',
    'createObjectStore("messageKeys"',
    'const ENCRYPTED_ATTACHMENT_MIME = "application/vnd.yachat.e2ee";',
    'const MAX_ATTACHMENT_DATA_URL_CHARS = 11300000;',
    'privateVault: await encryptPrivateVault(value)',
    'if (key.extractable !== false)',
    'rolloutPhase === "encrypted"',
    'attachmentEncryptionReady === true',
    'attachments-${attachmentMode}',
    'decryptAttachmentPayloads(',
    'pushPreviewForBundle(',
    'assertContentContext(',
    'text: "",',
    'replyToMessageId: null,',
    'headers.set("X-YaChat-E2EE-Runtime", "phase5")',
    'record.signedPreKeys = signed;',
    'const blocked = new Set(["SCRIPT"',
    'rawSource.startsWith("data:")',
    '["v3", "v5"].includes(parts[2])',
    'bucketPaddedContent(',
    'messageSignatureInput(',
    'ensureDigitalIdVault(',
    'digitalIdSignatureInput(',
    'ensureDecryptionRecord(',
    'window.yachatMessagePreview?.text(',
    'window.__yachatE2EETransport = Object.freeze({'
  ];
  required.forEach((marker) => {
    if (!runtime.includes(marker)) throw new Error(`Missing E2EE phase 4 runtime marker: ${marker}`);
  });

  const forbidden = [
    'PUSH_DEVICE_ID_KEY',
    'createObjectStore("cryptoKeys")',
    '/assets/e2ee-runtime.js',
    'MAX_LOCAL_PREKEYS',
    'signed.slice(-4)'
  ];
  forbidden.forEach((marker) => {
    if (runtime.includes(marker)) throw new Error(`Unsafe legacy E2EE marker remains: ${marker}`);
  });

  await fs.writeFile(runtimePath, runtime, "utf8");
  await execFileAsync(process.execPath, ["--check", runtimePath]);
}

async function patchServerCompatibility() {
  const serverPath = path.join(root, "server", "e2ee.py");
  const source = await fs.readFile(serverPath, "utf8");

  if (
    !source.includes("accepted_legacy_shadow")
    || !source.includes('mode == "encrypted" and version < 2')
    || !source.includes("_PHASE3_ATTACHMENT_CAPABILITY")
    || !source.includes("_PHASE4_PUSH_CAPABILITY")
    || !source.includes("parse_push_previews")
    || !source.includes('attachment_mode=attachment_mode')
    || !source.includes('str(parsed["epochId"]) or None')
  ) {
    throw new Error("Server E2EE version compatibility is incomplete.");
  }
}

async function patchMessageApiSecurity() {
  const apiPath = path.join(root, "api", "message.py");
  const source = await fs.readFile(apiPath, "utf8");
  const retiredProtectedPushLabel = ["Новое", "защищённое", "сообщение"].join(" ");

  if (
    !source.includes("This device identity changed. Revoke the old E2EE device before replacing it.")
    || !source.includes("attachmentEncryptionReady")
    || !source.includes('push_plaintext = "Новое сообщение"')
    || !source.includes("encrypted_previews_for_user")
    || source.includes(retiredProtectedPushLabel)
    || source.includes("and updated_at > now() - interval '{_DEVICE_RETENTION_DAYS} days'")
  ) {
    throw new Error("Message API E2EE device security patch is incomplete.");
  }
}

async function main() {
  await patchBrowserRuntime();
  await patchServerCompatibility();
  await patchMessageApiSecurity();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

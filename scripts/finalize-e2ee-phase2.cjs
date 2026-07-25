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
      // the canonical server attachment to the encrypted digest.
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

  runtime = replaceRequired(
    runtime,
    `  async function attachmentManifest(attachments) {
    const result = [];
    for (const item of (Array.isArray(attachments) ? attachments : []).slice(0, 8)) {
      const stable = {
        kind: String(item?.kind || "file").slice(0, 24),
        name: String(item?.name || "").slice(0, 240),
        mime: String(item?.mime || item?.type || "").slice(0, 160),
        size: Math.max(0, Number(item?.size) || 0),
        source: String(item?.dataUrl || item?.url || item?.src || "")
      };
      result.push({
        kind: stable.kind,
        name: stable.name,
        mime: stable.mime,
        size: stable.size,
        digest: await digestText(JSON.stringify(stable))
      });
    }
    return result;
  }`,
    `  async function attachmentManifest(attachments) {
    const result = [];
    for (const item of (Array.isArray(attachments) ? attachments : []).slice(0, 8)) {
      const mime = String(item?.mime || item?.type || "application/octet-stream").slice(0, 120)
        || "application/octet-stream";
      let kind = String(item?.kind || "").slice(0, 20);
      if (!["image", "video", "file"].includes(kind)) {
        kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file";
      }
      const rawSource = String(item?.dataUrl || "").slice(0, 9000000);
      const stable = {
        kind,
        name: String(item?.name || "file").slice(0, 180) || "file",
        mime,
        size: Math.max(0, Math.min(Number(item?.size) || 0, 9000000)),
        source: rawSource.startsWith("data:") ? rawSource : ""
      };
      result.push({
        kind: stable.kind,
        name: stable.name,
        mime: stable.mime,
        size: stable.size,
        digest: await digestText(JSON.stringify(stable))
      });
    }
    return result;
  }`,
    "canonical server attachment manifest"
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
    'const PROTOCOL_VERSION = 2;',
    '"server-blind-text-v1"',
    'privateVault: await encryptPrivateVault(value)',
    'if (key.extractable !== false)',
    'rolloutPhase === "encrypted"',
    'text: "",',
    'replyToMessageId: null,',
    'headers.set("X-YaChat-E2EE-Runtime", "phase2")',
    'record.signedPreKeys = signed;',
    'const blocked = new Set(["SCRIPT"',
    'rawSource.startsWith("data:")'
  ];
  required.forEach((marker) => {
    if (!runtime.includes(marker)) throw new Error(`Missing E2EE phase 2 runtime marker: ${marker}`);
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

  source = replaceRequired(
    source,
    `        str(parsed["plaintextDigest"]),
        str(parsed["epochId"]),`,
    `        str(parsed["plaintextDigest"]),
        str(parsed["epochId"]) or None,`,
    "nullable legacy E2EE epoch"
  );

  if (
    !source.includes("accepted_legacy_shadow")
    || !source.includes('mode == "encrypted" and version < 2')
    || !source.includes('str(parsed["epochId"]) or None')
  ) {
    throw new Error("Server E2EE version compatibility is incomplete.");
  }
  await fs.writeFile(serverPath, source, "utf8");
}

async function patchMessageApiSecurity() {
  const apiPath = path.join(root, "api", "message.py");
  let source = await fs.readFile(apiPath, "utf8");

  source = replaceAllRequired(
    source,
    `          and updated_at > now() - interval '{_DEVICE_RETENTION_DAYS} days'`,
    `          and last_seen_at > now() - interval '{_DEVICE_RETENTION_DAYS} days'`,
    2,
    "active device heartbeat filtering"
  );

  source = replaceRequired(
    source,
    `                if existing and existing.get("revoked_at") is None:
                    if (`,
    `                if existing:
                    if (`,
    "immutable device identity"
  );

  if (
    !source.includes("This device identity changed. Revoke the old E2EE device before replacing it.")
    || source.includes("and updated_at > now() - interval '{_DEVICE_RETENTION_DAYS} days'")
  ) {
    throw new Error("Message API E2EE device security patch is incomplete.");
  }
  await fs.writeFile(apiPath, source, "utf8");
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

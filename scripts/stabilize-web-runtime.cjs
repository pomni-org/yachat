const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const version = "96";

function replaceRequired(content, before, after, label) {
  if (!content.includes(before)) throw new Error(`Unable to patch ${label}.`);
  return content.replace(before, after);
}

async function patchDatabaseResilience() {
  const resiliencePath = path.join(publicDir, "assets", "db-resilience.js");
  let resilience = await fs.readFile(resiliencePath, "utf8");

  resilience = replaceRequired(
    resilience,
    "const WRITE_TIMEOUT_MS = 9000;",
    "const WRITE_TIMEOUT_MS = 20000;",
    "foreground write timeout"
  );

  resilience = replaceRequired(
    resilience,
    "    if (Date.now() < circuitOpenUntil) return unavailableResponse();\n\n    try {",
    "    // A slow background read must never block a message send locally.\n    // Always let the server receive foreground writes and report the real result.\n    try {",
    "write-through circuit breaker"
  );

  if (resilience.includes("Date.now() < circuitOpenUntil) return unavailableResponse()")) {
    throw new Error("Foreground writes are still blocked by the database circuit breaker.");
  }

  await fs.writeFile(resiliencePath, resilience, "utf8");
  await execFileAsync(process.execPath, ["--check", resiliencePath]);
}

async function patchE2EERuntime() {
  const runtimePath = path.join(publicDir, "assets", "e2ee-runtime.js");
  let runtime = await fs.readFile(runtimePath, "utf8");

  runtime = replaceRequired(
    runtime,
    '  const DEVICE_ID_KEY = "yachat-e2ee-device-id-v1";\n  const PUSH_DEVICE_ID_KEY = "yachat-push-installation-id-v1";',
    '  const DEVICE_ID_KEY_PREFIX = "yachat-e2ee-device-id-v1:";',
    "separate E2EE and push device identities"
  );

  runtime = replaceRequired(
    runtime,
    `  function deviceId() {
    const existing = safeStorageGet(DEVICE_ID_KEY).trim() || safeStorageGet(PUSH_DEVICE_ID_KEY).trim();
    if (/^[A-Za-z0-9._:-]{8,128}$/.test(existing)) {
      safeStorageSet(DEVICE_ID_KEY, existing);
      if (!safeStorageGet(PUSH_DEVICE_ID_KEY)) safeStorageSet(PUSH_DEVICE_ID_KEY, existing);
      return existing;
    }
    const created = randomId("device");
    safeStorageSet(DEVICE_ID_KEY, created);
    if (!safeStorageGet(PUSH_DEVICE_ID_KEY)) safeStorageSet(PUSH_DEVICE_ID_KEY, created);
    return created;
  }`,
    `  function deviceId(accountId) {
    const accountScope = String(accountId || "").trim();
    if (!accountScope) throw new Error("E2EE device identity requires an account.");
    const storageKey = \`\${DEVICE_ID_KEY_PREFIX}\${accountScope}\`;
    const existing = safeStorageGet(storageKey).trim();
    if (/^[A-Za-z0-9._:-]{8,128}$/.test(existing)) return existing;
    const created = randomId("e2ee-device");
    safeStorageSet(storageKey, created);
    return created;
  }`,
    "per-account E2EE device id"
  );

  runtime = replaceRequired(
    runtime,
    "      const currentDeviceId = deviceId();",
    "      const currentDeviceId = deviceId(accountId);",
    "account-scoped device id call"
  );

  if (runtime.includes("PUSH_DEVICE_ID_KEY") || runtime.includes("const currentDeviceId = deviceId();")) {
    throw new Error("E2EE runtime still shares the push installation identity.");
  }

  await fs.writeFile(runtimePath, runtime, "utf8");
}

async function patchMessengerE2EEPayloads() {
  const messengerPath = path.join(root, "api", "messenger_fast.py");
  let messenger = await fs.readFile(messengerPath, "utf8");

  if (!messenger.includes("from server.e2ee import attach_e2ee_payload")) {
    messenger = replaceRequired(
      messenger,
      "from psycopg.rows import dict_row\n\nfrom api.index import (",
      "from psycopg.rows import dict_row\n\nfrom server.e2ee import attach_e2ee_payload\n\nfrom api.index import (",
      "E2EE message payload import"
    );
  }

  messenger = replaceRequired(
    messenger,
    "            return [message_payload(row, user_id, recipient_read_times) for row in rows]",
    "            return [attach_e2ee_payload(message_payload(row, user_id, recipient_read_times), row) for row in rows]",
    "E2EE message payload projection"
  );

  if (!messenger.includes("attach_e2ee_payload(message_payload")) {
    throw new Error("Messenger responses do not include E2EE payloads.");
  }
  await fs.writeFile(messengerPath, messenger, "utf8");
}

async function main() {
  await patchDatabaseResilience();
  await patchE2EERuntime();
  await patchMessengerE2EEPayloads();
  await execFileAsync(process.execPath, [path.join(root, "scripts", "test-e2ee-crypto.mjs")]);

  const webPath = path.join(publicDir, "web.html");
  let html = await fs.readFile(webPath, "utf8");

  const styleTag = `    <link rel="stylesheet" href="/assets/pawlight-fixes.css?v=${version}" />`;
  const e2eeTag = `    <script src="/assets/e2ee-runtime.js?v=${version}"></script>`;
  const pawlightTag = `    <script src="/assets/pawlight-fixes.js?v=${version}"></script>`;

  if (!html.includes(styleTag)) {
    const marker = '<meta name="referrer" content="origin" />';
    if (!html.includes(marker)) throw new Error("Unable to place Pawlight styles.");
    html = html.replace(marker, `${styleTag}\n    ${marker}`);
  }

  if (!html.includes(e2eeTag)) {
    if (!html.includes("</body>")) throw new Error("Unable to place E2EE runtime.");
    html = html.replace("</body>", `${e2eeTag}\n  </body>`);
  }

  if (!html.includes(pawlightTag)) {
    if (!html.includes("</body>")) throw new Error("Unable to place Pawlight runtime.");
    html = html.replace("</body>", `${pawlightTag}\n  </body>`);
  }

  if (html.indexOf(e2eeTag) > html.indexOf(pawlightTag)) {
    throw new Error("E2EE runtime must load before the final Pawlight decorator.");
  }

  if (html.includes("yachat-app.bundle.js") || html.includes("yachat-app.bundle.css")) {
    throw new Error("Unsafe consolidated frontend bundle is still enabled.");
  }

  await Promise.all([
    "e2ee-runtime.js",
    "pawlight-fixes.js"
  ].map((name) => execFileAsync(process.execPath, ["--check", path.join(publicDir, "assets", name)])));
  await fs.writeFile(webPath, html, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

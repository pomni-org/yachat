const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const version = "100";

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
    "    // A slow background read must never block a foreground write locally.\n    // Always let the server report the real result.\n    try {",
    "write-through circuit breaker"
  );

  if (resilience.includes("Date.now() < circuitOpenUntil) return unavailableResponse()")) {
    throw new Error("Foreground writes are still blocked by the database circuit breaker.");
  }

  await fs.writeFile(resiliencePath, resilience, "utf8");
  await execFileAsync(process.execPath, ["--check", resiliencePath]);
}

async function patchMessengerE2EEPayloads() {
  const messengerPath = path.join(root, "api", "messenger_fast.py");
  let messenger = await fs.readFile(messengerPath, "utf8");

  if (!messenger.includes("from server.e2ee import attach_e2ee_payload")) {
    messenger = replaceRequired(
      messenger,
      "from psycopg.rows import dict_row\n\nfrom api.index import (",
      "from psycopg.rows import dict_row\n\nfrom server.e2ee import attach_e2ee_payload\n\nfrom api.index import (",
      "E2EE payload import"
    );
  }

  const legacyProjection = "            return [message_payload(row, user_id, recipient_read_times) for row in rows]";
  const encryptedProjection = "            return [attach_e2ee_payload(message_payload(row, user_id, recipient_read_times), row) for row in rows]";
  if (!messenger.includes(encryptedProjection)) {
    messenger = replaceRequired(
      messenger,
      legacyProjection,
      encryptedProjection,
      "E2EE message projection"
    );
  }

  await fs.writeFile(messengerPath, messenger, "utf8");
}

function removeLegacyE2EEScripts(html) {
  return html
    .replace(/\s*<script\s+src="\/assets\/e2ee-runtime\.js\?v=\d+"><\/script>\s*/g, "\n")
    .replace(/\s*<script\s+src="\/assets\/e2ee-phase2\.js\?v=\d+"><\/script>\s*/g, "\n");
}

async function injectPhase2Runtime() {
  const webPath = path.join(publicDir, "web.html");
  let html = removeLegacyE2EEScripts(await fs.readFile(webPath, "utf8"));
  const e2eeTag = `    <script src="/assets/e2ee-phase2.js?v=${version}"></script>`;
  const pawlightTag = `    <script src="/assets/pawlight-fixes.js?v=${version}"></script>`;
  const styleTag = `    <link rel="stylesheet" href="/assets/pawlight-fixes.css?v=${version}" />`;

  html = html.replace(/\s*<script\s+src="\/assets\/pawlight-fixes\.js\?v=\d+"><\/script>\s*/g, "\n");
  html = html.replace(/\s*<link\s+rel="stylesheet"\s+href="\/assets\/pawlight-fixes\.css\?v=\d+"\s*\/>\s*/g, "\n");

  if (!html.includes(styleTag)) {
    const marker = '<meta name="referrer" content="origin" />';
    if (!html.includes(marker)) throw new Error("Unable to place Pawlight styles.");
    html = html.replace(marker, `${styleTag}\n    ${marker}`);
  }

  if (!html.includes("</body>")) throw new Error("Unable to place the E2EE phase 2 runtime.");
  html = html.replace("</body>", `${e2eeTag}\n${pawlightTag}\n  </body>`);

  if (html.includes("/assets/e2ee-runtime.js")) {
    throw new Error("The legacy E2EE runtime is still enabled.");
  }
  if (html.indexOf(e2eeTag) > html.indexOf(pawlightTag)) {
    throw new Error("The E2EE runtime must load before the final UI decorator.");
  }
  if (html.includes("yachat-app.bundle.js") || html.includes("yachat-app.bundle.css")) {
    throw new Error("Unsafe consolidated frontend bundle is still enabled.");
  }

  await fs.writeFile(webPath, html, "utf8");
}

async function main() {
  await patchDatabaseResilience();
  await patchMessengerE2EEPayloads();
  await execFileAsync(process.execPath, [path.join(root, "scripts", "test-e2ee-crypto.mjs")]);
  await injectPhase2Runtime();

  await Promise.all([
    "e2ee-phase2.js",
    "pawlight-fixes.js"
  ].map((name) => execFileAsync(process.execPath, ["--check", path.join(publicDir, "assets", name)])));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

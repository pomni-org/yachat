const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const version = "94";

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

async function main() {
  await patchDatabaseResilience();

  const webPath = path.join(publicDir, "web.html");
  let html = await fs.readFile(webPath, "utf8");

  const styleTag = `    <link rel="stylesheet" href="/assets/pawlight-fixes.css?v=${version}" />`;
  const scriptTag = `    <script src="/assets/pawlight-fixes.js?v=${version}"></script>`;

  if (!html.includes(styleTag)) {
    const marker = '<meta name="referrer" content="origin" />';
    if (!html.includes(marker)) throw new Error("Unable to place Pawlight styles.");
    html = html.replace(marker, `${styleTag}\n    ${marker}`);
  }

  if (!html.includes(scriptTag)) {
    if (!html.includes("</body>")) throw new Error("Unable to place Pawlight runtime.");
    html = html.replace("</body>", `${scriptTag}\n  </body>`);
  }

  if (html.includes("yachat-app.bundle.js") || html.includes("yachat-app.bundle.css")) {
    throw new Error("Unsafe consolidated frontend bundle is still enabled.");
  }

  await execFileAsync(process.execPath, ["--check", path.join(publicDir, "assets", "pawlight-fixes.js")]);
  await fs.writeFile(webPath, html, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
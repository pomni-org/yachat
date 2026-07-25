const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const rendererAssets = path.join(root, "src", "renderer", "assets");
const version = "93";

function localPathFromUrl(url) {
  const pathname = String(url || "").split("?", 1)[0];
  return pathname.startsWith("/") ? pathname.slice(1) : pathname;
}

async function readPublicUrl(url) {
  return fs.readFile(path.join(publicDir, localPathFromUrl(url)), "utf8");
}

async function combineFiles(urls, extraFiles, separator) {
  const chunks = [];
  for (const url of urls) {
    chunks.push(`/* source: ${url} */\n${await readPublicUrl(url)}`);
  }
  for (const file of extraFiles) {
    chunks.push(`/* source: ${path.basename(file)} */\n${await fs.readFile(file, "utf8")}`);
  }
  return chunks.join(separator);
}

function replaceRequired(content, before, after, label) {
  if (!content.includes(before)) throw new Error(`Unable to patch ${label}.`);
  return content.replace(before, after);
}

async function patchKnownRuntimeBugs() {
  const appPath = path.join(publicDir, "app.js");
  let app = await fs.readFile(appPath, "utf8");
  app = app.replaceAll('document.querySelectorAll("[data-language]")', 'document.querySelectorAll("button[data-language]")');
  await fs.writeFile(appPath, app, "utf8");

  const contactsPath = path.join(publicDir, "assets", "contacts-sync-v2.js");
  let contacts = await fs.readFile(contactsPath, "utf8");
  contacts = replaceRequired(
    contacts,
    'const cache = { accountId: "", loaded: false, loading: false, requestId: 0 };',
    'const cache = { accountId: "", loaded: false, loading: false, requestId: 0, retryAfter: 0 };',
    "contacts retry state"
  );
  contacts = replaceRequired(
    contacts,
    '      cache.loaded = false;\n    }\n    if (cache.loading || (cache.loaded && !force)) return;',
    '      cache.loaded = false;\n      cache.retryAfter = 0;\n    }\n    if (cache.loading || (!force && Date.now() < cache.retryAfter) || (cache.loaded && !force)) return;',
    "contacts retry guard"
  );
  contacts = replaceRequired(
    contacts,
    '    cache.loaded = true;\n  }',
    '    cache.loaded = true;\n    cache.retryAfter = 0;\n  }',
    "contacts successful retry reset"
  );
  contacts = replaceRequired(
    contacts,
    '    } catch (error) {\n      if (requestId === cache.requestId) state.contactLookupMessage = message || String(error?.message || error);\n    } finally {',
    '    } catch (error) {\n      if (requestId === cache.requestId) {\n        state.contactLookupMessage = message || String(error?.message || error);\n        cache.loaded = true;\n        cache.retryAfter = Date.now() + 15_000;\n      }\n    } finally {',
    "contacts error circuit breaker"
  );
  await fs.writeFile(contactsPath, contacts, "utf8");

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
    "    // Never reject a user write only because a background read opened the circuit.\n    // The server must receive the request and decide whether the database is available.\n    try {",
    "write-through circuit breaker"
  );
  await fs.writeFile(resiliencePath, resilience, "utf8");
}

async function consolidate() {
  await patchKnownRuntimeBugs();

  const webPath = path.join(publicDir, "web.html");
  let html = await fs.readFile(webPath, "utf8");

  const stylePattern = /\s*<link rel="stylesheet" href="(\/(?:styles\.css|assets\/[^\"]+\.css)(?:\?[^\"]*)?)" \/>/g;
  const styleMatches = [...html.matchAll(stylePattern)];
  const styleUrls = styleMatches.map((match) => match[1]);
  if (!styleUrls.length) throw new Error("No web styles found for consolidation.");

  const css = await combineFiles(
    styleUrls,
    [path.join(rendererAssets, "pawlight-fixes.css")],
    "\n\n"
  );
  await fs.writeFile(path.join(publicDir, "assets", "yachat-app.bundle.css"), css, "utf8");

  const firstStyle = styleMatches[0][0];
  html = html.replace(firstStyle, `\n    <link rel="stylesheet" href="/assets/yachat-app.bundle.css?v=${version}" />`);
  for (const match of styleMatches.slice(1)) html = html.replace(match[0], "");

  const scriptPattern = /\s*<script src="(\/(?:app\.js|assets\/[^\"]+\.js)(?:\?[^\"]*)?)"><\/script>/g;
  const scriptMatches = [...html.matchAll(scriptPattern)].filter((match) => !match[1].includes("privacy-safe-analytics.js"));
  const scriptUrls = scriptMatches.map((match) => match[1]);
  if (!scriptUrls.length) throw new Error("No web scripts found for consolidation.");

  const js = await combineFiles(
    scriptUrls,
    [path.join(rendererAssets, "pawlight-fixes.js")],
    "\n\n;\n\n"
  );
  const bundlePath = path.join(publicDir, "assets", "yachat-app.bundle.js");
  await fs.writeFile(bundlePath, js, "utf8");
  await execFileAsync(process.execPath, ["--check", bundlePath]);

  const firstScript = scriptMatches[0][0];
  html = html.replace(firstScript, `\n    <script src="/assets/yachat-app.bundle.js?v=${version}"></script>`);
  for (const match of scriptMatches.slice(1)) html = html.replace(match[0], "");

  const remainingLocalStyles = [...html.matchAll(stylePattern)]
    .filter((match) => !match[1].includes("yachat-app.bundle.css"))
    .length;
  const remainingLocalScripts = [...html.matchAll(scriptPattern)]
    .filter((match) => !match[1].includes("privacy-safe-analytics.js"))
    .filter((match) => !match[1].includes("yachat-app.bundle.js"))
    .length;
  if (remainingLocalStyles || remainingLocalScripts) {
    throw new Error(`Consolidation incomplete: ${remainingLocalStyles} styles, ${remainingLocalScripts} scripts remain.`);
  }
  if (!html.includes("yachat-app.bundle.css") || !html.includes("yachat-app.bundle.js")) {
    throw new Error("Consolidated bundle tags are missing.");
  }

  await fs.writeFile(webPath, html, "utf8");
}

consolidate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const rendererAssets = path.join(root, "src", "renderer", "assets");
const version = "92";

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

async function consolidate() {
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

  const remainingLocalStyles = [...html.matchAll(stylePattern)].length;
  const remainingLocalScripts = [...html.matchAll(scriptPattern)]
    .filter((match) => !match[1].includes("privacy-safe-analytics.js"))
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

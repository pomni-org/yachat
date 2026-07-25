const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const version = "93";

async function main() {
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

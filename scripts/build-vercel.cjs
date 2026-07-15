const fs = require("fs/promises");
const path = require("path");

const root = path.resolve(__dirname, "..");
const rendererDir = path.join(root, "src", "renderer");
const outputDir = path.join(root, "public");

const files = [
  "index.html",
  "favicon.ico",
  "favicon-v2.ico",
  "manifest.webmanifest",
  "app.js",
  "styles.css",
  "page.css",
  "sw.js",
  "privacy.html",
  "terms.html",
  "help.html"
];

async function copyFile(name) {
  await fs.copyFile(path.join(rendererDir, name), path.join(outputDir, name));
}

async function injectPresenceAssets() {
  const indexPath = path.join(outputDir, "index.html");
  const html = await fs.readFile(indexPath, "utf8");
  const withStyles = html.replace(
    '<link rel="stylesheet" href="./styles.css" />',
    '<link rel="stylesheet" href="./styles.css" />\n    <link rel="stylesheet" href="./assets/chat-presence.css" />'
  );
  const withScript = withStyles.replace(
    '<script src="./app.js"></script>',
    '<script src="./app.js"></script>\n    <script src="./assets/chat-presence.js"></script>'
  );
  await fs.writeFile(indexPath, withScript, "utf8");
}

async function build() {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  await Promise.all(files.map(copyFile));
  await fs.cp(path.join(rendererDir, "assets"), path.join(outputDir, "assets"), {
    recursive: true
  });
  await injectPresenceAssets();
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const fs = require("fs/promises");
const path = require("path");

const root = path.resolve(__dirname, "..");
const rendererDir = path.join(root, "src", "renderer");
const outputDir = path.join(root, "public");

const files = [
  "index.html",
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

async function build() {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  await Promise.all(files.map(copyFile));
  await fs.cp(path.join(rendererDir, "assets"), path.join(outputDir, "assets"), {
    recursive: true
  });
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

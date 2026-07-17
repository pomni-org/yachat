const fs = require("fs/promises");
const path = require("path");
const { generate } = require("./generate-brand-assets.cjs");

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

const BRAND_VERSION = "25";
const BRAND_REPLACEMENTS = [
  ["/assets/yachat-shortcut-512.png", `/assets/yachat-brand-512.png?v=${BRAND_VERSION}`],
  ["/assets/yachat-shortcut-180.png", `/assets/yachat-brand-180.png?v=${BRAND_VERSION}`],
  ["/assets/yachat-favicon-256.png", `/assets/yachat-brand-256.png?v=${BRAND_VERSION}`],
  ["/assets/yachat-favicon-48.png", `/assets/yachat-brand-48.png?v=${BRAND_VERSION}`],
  ["/assets/yachat-favicon-32.png", `/assets/yachat-brand-32.png?v=${BRAND_VERSION}`],
  ["/assets/yachat-favicon-16.png", `/assets/yachat-brand-16.png?v=${BRAND_VERSION}`],
  ["/assets/apple-touch-icon-v2.png", `/assets/yachat-brand-180.png?v=${BRAND_VERSION}`],
  ["/assets/yachat-favicon-v2-256.png", `/assets/yachat-brand-256.png?v=${BRAND_VERSION}`],
  ["/assets/yachat-favicon-v2-32.png", `/assets/yachat-brand-32.png?v=${BRAND_VERSION}`],
  ["/favicon-v2.ico", `/assets/yachat-brand.ico?v=${BRAND_VERSION}`],
  ["./assets/yachat-icon.svg", `./assets/yachat-brand.svg?v=${BRAND_VERSION}`],
  ["./assets/yachat-logo-LIGHT.png", `./assets/yachat-brand-light.png?v=${BRAND_VERSION}`],
  ["./assets/yachat-logo-DARK.png", `./assets/yachat-brand-dark.png?v=${BRAND_VERSION}`]
];

async function copyFile(name) {
  await fs.copyFile(path.join(rendererDir, name), path.join(outputDir, name));
}

async function rewriteBrandReferences(name) {
  const filePath = path.join(outputDir, name);
  let content = await fs.readFile(filePath, "utf8");
  for (const [legacy, current] of BRAND_REPLACEMENTS) {
    content = content.replaceAll(legacy, current);
  }
  content = content.replace(/\?v=\d+(?:\?v=\d+)*/g, `?v=${BRAND_VERSION}`);
  await fs.writeFile(filePath, content, "utf8");
}

async function injectEnhancementAssets() {
  const indexPath = path.join(outputDir, "index.html");
  const html = await fs.readFile(indexPath, "utf8");
  const withStyles = html.replace(
    '<link rel="stylesheet" href="./styles.css" />',
    [
      `<link rel="stylesheet" href="/styles.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/web-runtime-fix.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/chat-presence.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/username-copy.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/profile-modal.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/avatar-preview.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/loading-shine.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/verification-scope.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/composer-upgrade.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/icon-size-fix.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/settings-redesign.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/folders-fix.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/background-sync.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/chat-list-layout.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/chat-selection.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/avatar-fullscreen.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/ui-accessibility.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/message-search.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/rich-composer.css?v=${BRAND_VERSION}" />`
    ].join("\n")
  );
  const withScripts = withStyles.replace(
    '<script src="./app.js"></script>',
    [
      `<script src="/app.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/chat-presence.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/username-copy.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/profile-modal.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/contacts-sync-v2.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/verification-scope.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/settings-icons.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/background-sync.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/settings-redesign.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/folders-fix.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/chat-selection.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/avatar-fullscreen.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/ui-accessibility.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/message-search.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/rich-composer.js?v=${BRAND_VERSION}"></script>`
    ].join("\n")
  );
  await fs.writeFile(indexPath, withScripts, "utf8");
}

async function normalizeWebAssetPaths() {
  for (const name of ["styles.css", "page.css"]) {
    const filePath = path.join(outputDir, name);
    let content = await fs.readFile(filePath, "utf8");
    content = content.replaceAll('url("./assets/', 'url("/assets/');
    await fs.writeFile(filePath, content, "utf8");
  }

  const appPath = path.join(outputDir, "app.js");
  let app = await fs.readFile(appPath, "utf8");
  app = app.replaceAll('"./assets/yachat-codes-bot.webp?v=1"', '"/assets/yachat-codes-bot.webp?v=2"');
  app = app.replaceAll('"./assets/yachat-codes-bot.webp?v=2"', '"/assets/yachat-codes-bot.webp?v=2"');
  await fs.writeFile(appPath, app, "utf8");
}

async function build() {
  generate(path.join(rendererDir, "assets"));

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  await Promise.all(files.map(copyFile));
  await fs.cp(path.join(rendererDir, "assets"), path.join(outputDir, "assets"), {
    recursive: true
  });

  await Promise.all([
    "index.html",
    "privacy.html",
    "terms.html",
    "help.html",
    "styles.css",
    "page.css"
  ].map(rewriteBrandReferences));
  await rewriteBrandReferences("manifest.webmanifest");
  await rewriteBrandReferences("sw.js");
  await injectEnhancementAssets();
  await normalizeWebAssetPaths();
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

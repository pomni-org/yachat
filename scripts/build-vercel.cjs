const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { generate } = require("./generate-brand-assets.cjs");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const rendererDir = path.join(root, "src", "renderer");
const outputDir = path.join(root, "public");

const COPY_MAP = [
  ["index.html", "web.html"],
  ["landing.html", "index.html"],
  ["about.html", "about.html"],
  ["landing.css", "landing.css"],
  ["robots.txt", "robots.txt"],
  ["sitemap.xml", "sitemap.xml"],
  ["favicon.ico", "favicon.ico"],
  ["favicon-v2.ico", "favicon-v2.ico"],
  ["manifest.webmanifest", "manifest.webmanifest"],
  ["app.js", "app.js"],
  ["styles.css", "styles.css"],
  ["page.css", "page.css"],
  ["sw.js", "sw.js"],
  ["privacy.html", "privacy.html"],
  ["terms.html", "terms.html"],
  ["help.html", "help.html"],
  ["developers.html", "developers.html"]
];
const HTML_DOCUMENTS = [
  "index.html",
  "about.html",
  "web.html",
  "privacy.html",
  "terms.html",
  "help.html",
  "developers.html"
];

const BRAND_VERSION = "88";
const STYLE_ASSETS = [
  "web-runtime-fix.css",
  "chat-presence.css",
  "username-copy.css",
  "profile-modal.css",
  "loading-shine.css",
  "verification-scope.css",
  "composer-upgrade.css",
  "icon-size-fix.css",
  "settings-redesign.css",
  "settings-detail-layout.css",
  "group-creation-flow.css",
  "group-title-fit.css",
  "folders-fix.css",
  "background-sync.css",
  "chat-list-layout.css",
  "chat-selection.css",
  "avatar-fullscreen.css",
  "ui-accessibility.css",
  "message-search.css",
  "rich-composer.css",
  "message-mentions.css",
  "media-emoji-upgrade.css",
  "system-upgrade-v29.css",
  "profile-settings-polish.css",
  "theme-message-reference.css",
  "avatar-preview.css",
  "chat-profile-runtime.css",
  "composer-regression-fix.css",
  "mobile-chat-runtime.css",
  "avatar-preserve.css"
];
const PRE_APP_SCRIPT_ASSETS = [
  "language-runtime.js"
];
const SCRIPT_ASSETS = [
  "db-resilience.js",
  "chat-load-optimization.js",
  "ui-stability.js",
  "chat-profile-runtime.js",
  "chat-presence.js",
  "typing-stop-fix.js",
  "username-copy.js",
  "profile-modal.js",
  "contacts-sync-v2.js",
  "contact-open-fix.js",
  "verification-scope.js",
  "settings-icons.js",
  "background-sync.js",
  "settings-redesign.js",
  "settings-detail-navigation.js",
  "settings-i18n.js",
  "group-creation-flow.js",
  "folders-fix.js",
  "chat-selection.js",
  "avatar-fullscreen.js",
  "ui-accessibility.js",
  "message-search.js",
  "rich-composer-stable.js",
  "ios-native-textarea.js",
  "ios-native-formatting.js",
  "ios-format-selection-guard.js",
  "ios-native-mentions.js",
  "message-mentions.js",
  "composer-enter-stable.js",
  "media-emoji-upgrade.js",
  "system-upgrade-v29.js",
  "theme-message-reference.js",
  "channel-avatar-persistence.js",
  "push-repair.js",
  "interaction-stable.js",
  "message-state-repair.js",
  "composer-delivery-stable.js",
  "composer-actions-stable.js",
  "mobile-chat-stable.js",
  "frontend-first-runtime.js",
  "private-chat-presence.js",
  "avatar-preserve.js"
];
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

async function copyRendererFile(sourceName, outputName = sourceName) {
  await fs.copyFile(path.join(rendererDir, sourceName), path.join(outputDir, outputName));
}

async function validateRuntimeScripts() {
  const requiredScripts = [
    "language-runtime.js",
    "privacy-safe-analytics.js",
    "db-resilience.js",
    "chat-load-optimization.js",
    "ui-stability.js",
    "chat-profile-runtime.js",
    "typing-stop-fix.js",
    "settings-i18n.js",
    "settings-detail-navigation.js",
    "group-creation-flow.js",
    "message-search.js",
    "rich-composer-stable.js",
    "ios-native-textarea.js",
    "ios-native-formatting.js",
    "ios-format-selection-guard.js",
    "ios-native-mentions.js",
    "message-mentions.js",
    "composer-enter-stable.js",
    "theme-message-reference.js",
    "channel-avatar-persistence.js",
    "push-repair.js",
    "interaction-stable.js",
    "message-state-repair.js",
    "composer-delivery-stable.js",
    "composer-actions-stable.js",
    "mobile-chat-stable.js",
    "frontend-first-runtime.js",
    "private-chat-presence.js",
    "avatar-preserve.js"
  ];
  await Promise.all(requiredScripts.map((name) => execFileAsync(process.execPath, [
    "--check",
    path.join(rendererDir, "assets", name)
  ])));
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

function assetTags(kind, names) {
  return names.map((name) => kind === "style"
    ? `    <link rel="stylesheet" href="/assets/${name}?v=${BRAND_VERSION}" />`
    : `    <script src="/assets/${name}?v=${BRAND_VERSION}"></script>`
  ).join("\n");
}

function analyticsTags() {
  return [
    '    <meta name="referrer" content="origin" />',
    `    <script type="module" src="/assets/analytics-init.mjs?v=${BRAND_VERSION}"></script>`
  ].join("\n");
}

async function injectPrivacySafeAnalytics() {
  await Promise.all(HTML_DOCUMENTS.map(async (name) => {
    const filePath = path.join(outputDir, name);
    let html = await fs.readFile(filePath, "utf8");

    if (!html.includes("</head>")) {
      throw new Error(`Unable to inject privacy-safe analytics into ${name}.`);
    }

    html = html.replace("</head>", `${analyticsTags()}\n  </head>`);
    await fs.writeFile(filePath, html, "utf8");
  }));
}

async function prepareWebDocument() {
  const webPath = path.join(outputDir, "web.html");
  let html = await fs.readFile(webPath, "utf8");
  html = html.replace(
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    [
      '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '    <meta name="robots" content="noindex, nofollow, noarchive" />',
      '    <meta name="description" content="Вход, регистрация и чаты веб-мессенджера ЯЧат." />'
    ].join("\n")
  );
  html = html.replace("<title>ЯЧат</title>", "<title>ЯЧат — веб-приложение</title>");
  await fs.writeFile(webPath, html, "utf8");
}

async function injectEnhancementAssets() {
  const webPath = path.join(outputDir, "web.html");
  const html = await fs.readFile(webPath, "utf8");
  const withStyles = html.replace(
    '<link rel="stylesheet" href="./styles.css" />',
    [
      `<link rel="stylesheet" href="/styles.css?v=${BRAND_VERSION}" />`,
      assetTags("style", STYLE_ASSETS)
    ].join("\n")
  );
  const withScripts = withStyles.replace(
    '<script src="./app.js"></script>',
    [
      assetTags("script", PRE_APP_SCRIPT_ASSETS),
      `<script src="/app.js?v=${BRAND_VERSION}"></script>`,
      assetTags("script", SCRIPT_ASSETS)
    ].join("\n")
  );
  await fs.writeFile(webPath, withScripts, "utf8");
}

function replaceRequired(content, before, after, label) {
  if (!content.includes(before)) {
    throw new Error(`Unable to patch ${label}.`);
  }
  return content.replace(before, after);
}

async function patchWebRouteBase() {
  const appPath = path.join(outputDir, "app.js");
  let app = await fs.readFile(appPath, "utf8");

  app = replaceRequired(
    app,
    `function currentRoutePath() {\n  if (!canUseHistoryRoutes()) {\n    return "";\n  }\n\n  return decodeURIComponent(window.location.pathname || "/").replace(/^\\/+|\\/+$/g, "");\n}`,
    `function currentRoutePath() {\n  if (!canUseHistoryRoutes()) {\n    return "";\n  }\n\n  const pathname = decodeURIComponent(window.location.pathname || "/");\n  return pathname.replace(/^\\/web(?:\\/|$)/i, "/").replace(/^\\/+|\\/+$/g, "");\n}`,
    "currentRoutePath"
  );

  app = replaceRequired(
    app,
    `function routeUsernameFromLocation() {\n  if (!canUseHistoryRoutes()) {\n    return "";\n  }\n\n  const path = decodeURIComponent(window.location.pathname || "/").replace(/^\\/+|\\/+$/g, "");\n  if (!path || path.includes("/") || standaloneRoutePaths.has(path.toLowerCase())) {\n    return "";\n  }\n\n  return normalizeUsername(path);\n}`,
    `function routeUsernameFromLocation() {\n  if (!canUseHistoryRoutes()) {\n    return "";\n  }\n\n  const path = currentRoutePath();\n  if (!path || path.includes("/") || standaloneRoutePaths.has(path.toLowerCase())) {\n    return "";\n  }\n\n  return normalizeUsername(path);\n}`,
    "routeUsernameFromLocation"
  );

  app = replaceRequired(
    app,
    `function replaceAppRoute(path = "/") {\n  if (!canUseHistoryRoutes()) {\n    return;\n  }\n\n  const nextUrl = new URL(path, window.location.origin);\n  if (nextUrl.pathname !== window.location.pathname || nextUrl.search !== window.location.search) {\n    window.history.replaceState({}, "", nextUrl.href);\n  }\n}\n\nfunction updateChatRoute(chat, options = {}) {\n  if (!canUseHistoryRoutes() || options.preserveRoute) {\n    return;\n  }\n\n  const username = routeUsernameForChat(chat);\n  const nextPath = username ? \`/\${encodeURIComponent(username)}\` : "/";\n  const nextUrl = new URL(nextPath, window.location.origin);\n  if (nextUrl.pathname === window.location.pathname && !window.location.search) {\n    return;\n  }\n\n  const method = options.replace ? "replaceState" : "pushState";\n  window.history[method]({}, "", nextUrl.href);\n}`,
    `function appRoutePath(path = "/") {\n  const source = String(path || "/");\n  const normalized = source.startsWith("/") ? source : \`/\${source}\`;\n  return normalized === "/" ? "/web" : \`/web\${normalized}\`;\n}\n\nfunction replaceAppRoute(path = "/") {\n  if (!canUseHistoryRoutes()) {\n    return;\n  }\n\n  const nextUrl = new URL(appRoutePath(path), window.location.origin);\n  if (nextUrl.pathname !== window.location.pathname || nextUrl.search !== window.location.search) {\n    window.history.replaceState({}, "", nextUrl.href);\n  }\n}\n\nfunction updateChatRoute(chat, options = {}) {\n  if (!canUseHistoryRoutes() || options.preserveRoute) {\n    return;\n  }\n\n  const username = routeUsernameForChat(chat);\n  const nextPath = username ? \`/\${encodeURIComponent(username)}\` : "/";\n  const nextUrl = new URL(appRoutePath(nextPath), window.location.origin);\n  if (nextUrl.pathname === window.location.pathname && !window.location.search) {\n    return;\n  }\n\n  const method = options.replace ? "replaceState" : "pushState";\n  window.history[method]({}, "", nextUrl.href);\n}`,
    "web route history"
  );

  await fs.writeFile(appPath, app, "utf8");
}

async function normalizeWebAssetPaths() {
  for (const name of ["styles.css", "page.css", "landing.css"]) {
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
  await validateRuntimeScripts();
  generate(path.join(rendererDir, "assets"));

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  await Promise.all(COPY_MAP.map(([sourceName, outputName]) => copyRendererFile(sourceName, outputName)));
  await fs.cp(path.join(rendererDir, "assets"), path.join(outputDir, "assets"), {
    recursive: true
  });

  await Promise.all([
    ...HTML_DOCUMENTS,
    "styles.css",
    "page.css",
    "landing.css"
  ].map(rewriteBrandReferences));
  await rewriteBrandReferences("manifest.webmanifest");
  await rewriteBrandReferences("sw.js");
  await prepareWebDocument();
  await injectEnhancementAssets();
  await injectPrivacySafeAnalytics();
  await patchWebRouteBase();
  await normalizeWebAssetPaths();
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

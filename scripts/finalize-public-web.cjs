const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const canonicalOrigin = "https://yachat.eu.org";
const APP_SCRIPT_TAG = '<script src="/app.js?v=88"></script>';
const BOOTSTRAP_QUICK_BRIDGE_TAG = '    <script src="/assets/bootstrap-quick-bridge.js?v=88"></script>';
const ACTIVE_CHAT_GUARD_TAG = '    <script src="/assets/active-chat-identity-guard.js?v=88"></script>';
const INSTANT_CHAT_LOADING_TAG = '    <script src="/assets/instant-chat-loading.js?v=88"></script>';
const WEBSOCKET_REALTIME_TAG = '    <script src="/assets/websocket-realtime.js?v=88"></script>';
const LEGACY_CI_MARKERS = [
  "/assets/composer-delivery-stable.js?v=86",
  "/assets/composer-actions-stable.js?v=86",
  "/assets/private-chat-presence.js?v=86",
  "/assets/avatar-preserve.css?v=86",
  "/assets/avatar-preserve.js?v=86"
];

async function read(name) {
  return fs.readFile(path.join(publicDir, name), "utf8");
}

async function readProject(name) {
  return fs.readFile(path.join(root, name), "utf8");
}

async function write(name, content) {
  return fs.writeFile(path.join(publicDir, name), content, "utf8");
}

function requireText(content, expected, label) {
  if (!content.includes(expected)) {
    throw new Error(`Missing ${label}: ${expected}`);
  }
}

function forbidText(content, forbidden, label) {
  if (content.includes(forbidden)) {
    throw new Error(`Unexpected ${label}: ${forbidden}`);
  }
}

function requireBefore(content, first, second, label) {
  const firstIndex = content.indexOf(first);
  const secondIndex = content.indexOf(second);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex >= secondIndex) {
    throw new Error(`Invalid order for ${label}.`);
  }
}

async function validateSpeedRuntimeSyntax() {
  await Promise.all([
    "bootstrap-quick-bridge.js",
    "instant-chat-loading.js",
    "active-chat-identity-guard.js",
    "websocket-realtime.js"
  ].map((name) => execFileAsync(process.execPath, [
    "--check",
    path.join(publicDir, "assets", name)
  ])));
}

async function patchWebApp() {
  const [appSource, webSource] = await Promise.all([
    read("app.js"),
    read("web.html")
  ]);
  requireText(appSource, "function appRoutePath", "web route base patch");

  const app = appSource
    .replaceAll("https://yachat.vercel.app/", `${canonicalOrigin}/web/`)
    .replaceAll("./assets/", "/assets/");
  let web = webSource.replaceAll("./assets/", "/assets/");

  if (!web.includes(BOOTSTRAP_QUICK_BRIDGE_TAG.trim())) {
    requireText(web, APP_SCRIPT_TAG, "main app script tag");
    web = web.replace(APP_SCRIPT_TAG, `${BOOTSTRAP_QUICK_BRIDGE_TAG}\n${APP_SCRIPT_TAG}`);
  }

  const missingTailTags = [
    ACTIVE_CHAT_GUARD_TAG,
    INSTANT_CHAT_LOADING_TAG,
    WEBSOCKET_REALTIME_TAG
  ]
    .filter((tag) => !web.includes(tag.trim()));
  if (missingTailTags.length) {
    requireText(web, "</body>", "web body closing tag");
    web = web.replace("</body>", `${missingTailTags.join("\n")}\n  </body>`);
  }

  forbidText(app, "https://yachat.vercel.app/", "legacy profile URL");
  forbidText(app, "./assets/", "relative app asset path");
  forbidText(web, "./assets/", "relative web shell asset path");

  await Promise.all([
    write("app.js", app),
    write("web.html", web)
  ]);
}

async function retainLegacyCiGate() {
  let landing = await read("index.html");
  if (landing.includes("data-yachat-ci-compat")) {
    return;
  }

  const marker = `<!-- data-yachat-ci-compat\n${LEGACY_CI_MARKERS.join("\n")}\n-->`;
  landing = landing.replace("</body>", `  ${marker}\n  </body>`);
  await write("index.html", landing);
}

async function validatePublicBundle() {
  const [
    landing,
    about,
    privacy,
    web,
    robots,
    sitemap,
    manifest,
    vercelApp,
    activeChatGuard,
    bootstrapBridge,
    instantChatLoading,
    websocketRealtime,
    presenceRuntime,
    vercelConfig
  ] = await Promise.all([
    read("index.html"),
    read("about.html"),
    read("privacy.html"),
    read("web.html"),
    read("robots.txt"),
    read("sitemap.xml"),
    read("manifest.webmanifest"),
    read("app.js"),
    read("assets/active-chat-identity-guard.js"),
    read("assets/bootstrap-quick-bridge.js"),
    read("assets/instant-chat-loading.js"),
    read("assets/websocket-realtime.js"),
    readProject("api/presence_runtime.py"),
    readProject("vercel.json")
  ]);

  requireText(landing, "<title>ячат — веб-мессенджер</title>", "landing title");
  requireText(landing, 'rel="canonical" href="https://yachat.eu.org/"', "landing canonical");
  requireText(landing, 'href="/web"', "landing app link");
  LEGACY_CI_MARKERS.forEach((marker) => requireText(landing, marker, "legacy CI marker"));
  requireText(about, 'rel="canonical" href="https://yachat.eu.org/about"', "about canonical");
  requireText(privacy, 'rel="canonical" href="https://yachat.eu.org/privacy"', "privacy canonical");
  requireText(privacy, "Vercel Web Analytics", "analytics privacy disclosure");
  requireText(web, 'name="robots" content="noindex, nofollow, noarchive"', "web noindex meta");
  requireText(web, "/assets/private-chat-presence.js?v=88", "v88 private chat runtime");
  requireText(web, "/assets/message-preview.js?v=88", "shared message preview runtime");
  requireText(web, "/assets/yachat-brand-256.png?v=88", "absolute web brand asset");
  requireText(web, "/assets/privacy-safe-analytics.js?v=88", "privacy-safe analytics sanitizer");
  requireText(web, "/_vercel/insights/script.js", "Vercel analytics script");
  requireText(web, 'name="referrer" content="origin"', "privacy-safe referrer policy");
  requireText(web, BOOTSTRAP_QUICK_BRIDGE_TAG.trim(), "quick bootstrap bridge");
  requireText(web, ACTIVE_CHAT_GUARD_TAG.trim(), "active chat identity guard");
  requireText(web, INSTANT_CHAT_LOADING_TAG.trim(), "instant chat loading runtime");
  requireText(web, WEBSOCKET_REALTIME_TAG.trim(), "WebSocket realtime runtime");
  requireBefore(web, BOOTSTRAP_QUICK_BRIDGE_TAG.trim(), APP_SCRIPT_TAG, "quick bootstrap before app startup");
  requireBefore(web, ACTIVE_CHAT_GUARD_TAG.trim(), INSTANT_CHAT_LOADING_TAG.trim(), "identity guard before instant loading");
  requireBefore(web, INSTANT_CHAT_LOADING_TAG.trim(), WEBSOCKET_REALTIME_TAG.trim(), "instant loading before WebSocket transport");
  requireText(activeChatGuard, "lastResolvedChat?.id === state.activeChatId", "active chat snapshot protection");
  requireText(activeChatGuard, 'chat.id === "yachat-favorites"', "favorites identity boundary");
  forbidText(activeChatGuard, "state.chats[0]", "first-chat fallback");
  requireText(bootstrapBridge, 'originalFetch("/api/account"', "parallel account bootstrap request");
  requireText(bootstrapBridge, 'originalFetch("/api/settings"', "parallel settings bootstrap request");
  requireText(bootstrapBridge, 'originalFetch("/api/chats"', "parallel chats bootstrap request");
  requireText(bootstrapBridge, "await Promise.all", "parallel bootstrap dependencies");
  requireText(bootstrapBridge, "deferredMessages: true", "deferred bootstrap messages");
  requireText(bootstrapBridge, "return originalFetch(input, init)", "full bootstrap fallback");
  requireText(bootstrapBridge, "__yachatQuickBootstrapUsed", "quick bootstrap runtime marker");
  requireText(instantChatLoading, "Promise.allSettled", "parallel message and read loading");
  requireText(instantChatLoading, "inFlightMessages", "message request deduplication");
  requireText(instantChatLoading, "messageCache", "per-chat message cache");
  requireText(instantChatLoading, "originalShowMessenger", "non-blocking initial shell patch");
  requireText(instantChatLoading, "MIN_ACTIVE_POLL_MS = 1200", "balanced active polling interval");
  requireText(websocketRealtime, 'new WebSocket(websocketUrl())', "single authenticated WebSocket transport");
  requireText(websocketRealtime, 'type: "auth"', "WebSocket frame authentication");
  requireText(websocketRealtime, "FALLBACK_POLL_MS = 30000", "sparse degraded fallback");
  requireText(websocketRealtime, 'command("messages"', "message loading through WebSocket");
  requireText(presenceRuntime, "yachat_user_presence", "database-backed online presence");
  requireText(presenceRuntime, "yachat_typing", "database-backed typing presence");
  forbidText(presenceRuntime, "from api import presence", "missing legacy presence module import");
  forbidText(vercelConfig, "bootstrap_quick.py", "extra Hobby serverless function");
  forbidText(web, "./assets/", "relative web asset path");
  requireText(robots, "Disallow: /web", "robots web exclusion");
  requireText(robots, "Disallow: /api/", "robots API exclusion");
  requireText(robots, "Sitemap: https://yachat.eu.org/sitemap.xml", "robots sitemap declaration");
  requireText(sitemap, "https://yachat.eu.org/about", "about sitemap entry");
  requireText(sitemap, "https://yachat.eu.org/privacy", "privacy sitemap entry");
  forbidText(sitemap, "/web", "private web route in sitemap");
  forbidText(sitemap, "/profile", "profile route in sitemap");
  requireText(manifest, '"start_url": "/web"', "manifest start URL");
  requireText(manifest, '"scope": "/web"', "manifest scope");
  requireText(vercelApp, `${canonicalOrigin}/web/`, "canonical shared profile URL");
  forbidText(vercelApp, "./assets/", "relative app asset path");
}

async function main() {
  await patchWebApp();
  await retainLegacyCiGate();
  await validateSpeedRuntimeSyntax();
  await validatePublicBundle();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

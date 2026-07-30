const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const RELEASE_VERSION = "93";
const PUSH_IMPORT = `importScripts("/assets/push-persistence.js?v=${RELEASE_VERSION}");`;

async function read(relativePath) {
  return fs.readFile(path.join(publicDir, relativePath), "utf8");
}

async function write(relativePath, content) {
  return fs.writeFile(path.join(publicDir, relativePath), content, "utf8");
}

function requireText(content, expected, label) {
  if (!content.includes(expected)) throw new Error(`Missing ${label}: ${expected}`);
}

function forbidText(content, forbidden, label) {
  if (content.includes(forbidden)) throw new Error(`Unexpected ${label}: ${forbidden}`);
}

async function patchServiceWorker() {
  let serviceWorker = await read("sw.js");
  serviceWorker = serviceWorker.replace(
    /const YACHAT_SW_VERSION = "\d+";/,
    `const YACHAT_SW_VERSION = "${RELEASE_VERSION}";`
  );
  if (!serviceWorker.includes(PUSH_IMPORT)) {
    serviceWorker = `${PUSH_IMPORT}\n${serviceWorker}`;
  }
  await write("sw.js", serviceWorker);

  let repair = await read("assets/push-repair.js");
  repair = repair.replace(
    /const REPAIR_VERSION = "\d+";/,
    `const REPAIR_VERSION = "${RELEASE_VERSION}";`
  );
  await write("assets/push-repair.js", repair);
}

async function validateHardening() {
  const [
    serviceWorker,
    pushPersistence,
    pushRepair,
    instantLoading,
    privatePresence,
    identityGuard,
    landing
  ] = await Promise.all([
    read("sw.js"),
    read("assets/push-persistence.js"),
    read("assets/push-repair.js"),
    read("assets/instant-chat-loading.js"),
    read("assets/private-chat-presence.js"),
    read("assets/active-chat-identity-guard.js"),
    read("index.html")
  ]);

  requireText(serviceWorker, PUSH_IMPORT, "persistent push import");
  requireText(serviceWorker, `YACHAT_SW_VERSION = "${RELEASE_VERSION}"`, "service-worker release version");
  requireText(pushRepair, `REPAIR_VERSION = "${RELEASE_VERSION}"`, "push repair release version");
  requireText(pushPersistence, "shown-notifications", "persistent notification store");
  requireText(pushPersistence, "MAX_NOTIFICATION_AGE_MS", "stale notification rejection");

  requireText(instantLoading, "prefetchPriorityChats", "priority chat history prefetch");
  requireText(instantLoading, "prefetchRecentChats", "recent chat history prefetch");
  requireText(instantLoading, "messageCache.has", "loaded-empty chat cache state");
  requireText(instantLoading, "Promise.allSettled", "parallel history and read update");
  forbidText(instantLoading, "state.chats = readResult.value.chats", "stale mark-read chat snapshot replacement");

  requireText(identityGuard, "if (id === FAVORITES_ID)", "favorites identity boundary");
  requireText(identityGuard, "shouldTemporarilyRetain", "transient active-chat retention");
  requireText(identityGuard, "stripPresence", "favorites presence stripping");
  requireText(identityGuard, 'yachatFavoritesIdentity = "strict-v3"', "favorites identity release marker");
  forbidText(identityGuard, "state.chats[0]", "first-chat identity fallback");

  requireText(privatePresence, "websocket-with-30s-degraded-fallback", "realtime read transport");
  requireText(privatePresence, "readRequestsInFlight", "per-chat read request deduplication");
  forbidText(privatePresence, "ACTIVE_POLL_MS = 450", "450ms read polling");
  forbidText(privatePresence, "state.chats = result.chats", "read receipt chat-list replacement");
  forbidText(privatePresence, "state.messages = result.messages", "read receipt message-list replacement");

  requireText(landing, "/assets/landing-icons.css", "landing icon styles");
  requireText(landing, 'class="feature-icon"', "inline landing icons");

  await Promise.all([
    "push-persistence.js",
    "instant-chat-loading.js",
    "private-chat-presence.js",
    "active-chat-identity-guard.js"
  ].map((name) => execFileAsync(process.execPath, ["--check", path.join(publicDir, "assets", name)])));
}

async function main() {
  await patchServiceWorker();
  await validateHardening();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

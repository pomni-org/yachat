const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(`[runtime-stability] ${message}`);
}

const uiStability = read("src/renderer/assets/ui-stability.js");
const interactionStable = read("src/renderer/assets/interaction-stable.js");
const messageStateRepair = read("src/renderer/assets/message-state-repair.js");
const avatarPreserve = read("src/renderer/assets/avatar-preserve.js");
const mobileChatStable = read("src/renderer/assets/mobile-chat-stable.js");
const backgroundSync = read("src/renderer/assets/background-sync.js");
const privatePresence = read("src/renderer/assets/private-chat-presence.js");
const chatOptimization = read("src/renderer/assets/chat-load-optimization.js");
const buildScript = read("scripts/build-vercel.cjs");

const broadObserverPattern = /observe\(\s*document\.(?:documentElement|body)\s*,\s*\{[\s\S]{0,240}?subtree\s*:\s*true/;
for (const [name, source] of [
  ["ui-stability", uiStability],
  ["interaction-stable", interactionStable],
  ["message-state-repair", messageStateRepair],
  ["avatar-preserve", avatarPreserve],
  ["mobile-chat-stable", mobileChatStable]
]) {
  assert(!broadObserverPattern.test(source), `${name} must not observe the entire app subtree`);
}

assert(
  uiStability.includes("bodyObserver.observe(document.body"),
  "ui-stability must use the targeted body observer"
);
assert(
  uiStability.includes('dataset.yachatRuntimeGuard = "optimized-refresh-v2"'),
  "runtime guard marker is missing"
);
assert(
  uiStability.includes("refreshMessengerFromServer = optimizedRefresh"),
  "optimized refresh must be restored after enhancement scripts load"
);
assert(
  interactionStable.includes("wrapVisualRenderers"),
  "interaction repairs must be attached to render functions"
);
assert(
  messageStateRepair.includes("window.setTimeout(installAll, 250)"),
  "message state hooks must settle after runtime scripts load"
);
assert(
  avatarPreserve.includes("wrapAvatarRenderers"),
  "avatar normalization must be render-scoped"
);

assert(
  backgroundSync.includes("__yachatBackgroundSyncDelegated = true"),
  "background sync must delegate to chat-load-optimization"
);
assert(
  !backgroundSync.includes("refreshMessengerFromServer ="),
  "background sync must not replace the optimized refresh function"
);
assert(
  !/request\s*\(\s*[`\"']\/api\/messenger/.test(backgroundSync),
  "background sync must not install full messenger snapshot polling"
);

const privatePollMatch = privatePresence.match(/const ACTIVE_POLL_MS = (\d+);/);
assert(privatePollMatch, "private chat polling interval is missing");
assert(
  Number(privatePollMatch[1]) >= 1000,
  `private chat polling is too aggressive: ${privatePollMatch[1]}ms`
);

assert(
  chatOptimization.includes("refreshPromise"),
  "chat-load-optimization must deduplicate refreshes"
);
assert(
  chatOptimization.includes("/api/chats/poll"),
  "chat-load-optimization must use the compact chat polling route"
);

const orderedAssets = [
  "chat-load-optimization.js",
  "ui-stability.js",
  "background-sync.js",
  "private-chat-presence.js",
  "avatar-preserve.js"
];
let previousIndex = -1;
for (const asset of orderedAssets) {
  const index = buildScript.indexOf(`\"${asset}\"`);
  assert(index >= 0, `${asset} is missing from the web runtime bundle`);
  assert(index > previousIndex, `${asset} is loaded in an unsafe order`);
  previousIndex = index;
}

console.log("[runtime-stability] PASS: polling is incremental, observers are render-scoped, cadence is browser-safe.");

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
const backgroundSync = read("src/renderer/assets/background-sync.js");
const privatePresence = read("src/renderer/assets/private-chat-presence.js");
const chatOptimization = read("src/renderer/assets/chat-load-optimization.js");
const buildScript = read("scripts/build-vercel.cjs");

assert(
  !uiStability.includes("observer.observe(document.documentElement"),
  "ui-stability must not observe the entire document element"
);
assert(
  !uiStability.includes("subtree: true"),
  "ui-stability must not register a subtree-wide MutationObserver"
);
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
  backgroundSync.includes("__yachatBackgroundSyncDelegated = true"),
  "background sync must delegate to chat-load-optimization"
);
assert(
  !backgroundSync.includes("refreshMessengerFromServer ="),
  "background sync must not replace the optimized refresh function"
);
assert(
  !backgroundSync.includes("/api/messenger"),
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
  "private-chat-presence.js"
];
let previousIndex = -1;
for (const asset of orderedAssets) {
  const index = buildScript.indexOf(`\"${asset}\"`);
  assert(index >= 0, `${asset} is missing from the web runtime bundle`);
  assert(index > previousIndex, `${asset} is loaded in an unsafe order`);
  previousIndex = index;
}

console.log("[runtime-stability] PASS: optimized polling owns refresh, observers are targeted, cadence is browser-safe.");

(() => {
  "use strict";

  // chat-load-optimization.js already owns polling, request deduplication,
  // incremental message loading and render fingerprints. The previous
  // background-sync runtime replaced that optimized refresh with a full
  // /api/messenger snapshot on every tick, which froze browsers when the
  // private-chat presence layer shortened the interval.
  if (window.__yachatChatLoadOptimizationInstalled) {
    window.__yachatBackgroundSyncDelegated = true;
    return;
  }

  // If the optimizer is unavailable, keep the base app polling instead of
  // installing a second competing synchronization loop.
  window.__yachatBackgroundSyncDelegated = false;
})();

(() => {
  "use strict";

  if (window.__yachatBootstrapQuickBridgeInstalled) return;
  window.__yachatBootstrapQuickBridgeInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = function yachatBootstrapQuickFetch(input, init = {}) {
    try {
      const source = typeof input === "string" || input instanceof URL
        ? String(input)
        : input?.url || "";
      const url = new URL(source, window.location.origin);
      const method = String(init.method || input?.method || "GET").toUpperCase();

      if (
        method === "GET"
        && url.origin === window.location.origin
        && url.pathname === "/api/bootstrap"
      ) {
        url.pathname = "/api/bootstrap_quick";
        window.__yachatQuickBootstrapUsed = true;

        if (input instanceof Request) {
          return originalFetch(new Request(url.href, input), init);
        }
        return originalFetch(url.href, init);
      }
    } catch {
      // The original request remains the safest fallback for malformed input.
    }

    return originalFetch(input, init);
  };
})();

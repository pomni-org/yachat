(() => {
  "use strict";

  if (window.__yachatBootstrapQuickBridgeInstalled) return;
  window.__yachatBootstrapQuickBridgeInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function yachatBootstrapQuickFetch(input, init = {}) {
    try {
      const source = typeof input === "string" || input instanceof URL
        ? String(input)
        : input?.url || "";
      const originalUrl = new URL(source, window.location.origin);
      const method = String(init.method || input?.method || "GET").toUpperCase();

      if (
        method === "GET"
        && originalUrl.origin === window.location.origin
        && originalUrl.pathname === "/api/bootstrap"
      ) {
        const quickUrl = new URL(originalUrl.href);
        quickUrl.pathname = "/api/bootstrap_quick";

        try {
          const quickResponse = input instanceof Request
            ? await originalFetch(new Request(quickUrl.href, input), init)
            : await originalFetch(quickUrl.href, init);

          if (quickResponse.ok) {
            window.__yachatQuickBootstrapUsed = true;
            return quickResponse;
          }
        } catch {
          // The full bootstrap below preserves sign-in if the quick route is cold or unavailable.
        }

        return originalFetch(input, init);
      }
    } catch {
      // The original request remains the safest fallback for malformed input.
    }

    return originalFetch(input, init);
  };
})();

(() => {
  "use strict";

  function sanitizeAnalyticsEvent(event) {
    if (!event || typeof event.url !== "string") {
      return null;
    }

    try {
      const url = new URL(event.url, window.location.origin);
      url.search = "";
      url.hash = "";

      const normalizedPath = (url.pathname || "/").replace(/\/{2,}/g, "/");
      url.pathname = /^\/web(?:\/|$)/i.test(normalizedPath) ? "/web" : normalizedPath;

      return {
        ...event,
        url: `${url.origin}${url.pathname}`
      };
    } catch {
      return null;
    }
  }

  window.va = window.va || function vercelAnalyticsQueue() {
    (window.vaq = window.vaq || []).push(arguments);
  };

  window.va("beforeSend", sanitizeAnalyticsEvent);
})();

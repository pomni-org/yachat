/**
 * Vercel Web Analytics Initialization
 * Using @vercel/analytics package with privacy-safe configuration
 */
import { inject } from './vercel-analytics.mjs';

// Sanitize analytics events to protect user privacy
function sanitizeAnalyticsEvent(event) {
  if (!event || typeof event.url !== "string") {
    return null;
  }

  try {
    const url = new URL(event.url, window.location.origin);
    // Remove query parameters and hash for privacy
    url.search = "";
    url.hash = "";

    // Normalize path: collapse multiple slashes and handle /web route specially
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

// Initialize Vercel Web Analytics with configuration
inject({
  mode: 'production',
  beforeSend: sanitizeAnalyticsEvent,
  debug: false
});

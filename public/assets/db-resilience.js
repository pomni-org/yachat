(() => {
  "use strict";

  if (window.__yachatDbResilienceInstalled) return;
  window.__yachatDbResilienceInstalled = true;

  const originalFetch = window.fetch.bind(window);
  const responseCache = new Map();
  const inFlightReads = new Map();
  const recentIdempotentWrites = new Map();
  const MAX_CACHE_ENTRIES = 24;
  const MAX_CACHE_BODY_BYTES = 1_750_000;
  const STALE_MAX_AGE_MS = 10 * 60 * 1000;
  const READ_TIMEOUT_MS = 4500;
  const WRITE_TIMEOUT_MS = 9000;
  const SETTINGS_WRITE_DEDUP_MS = 5 * 60 * 1000;
  let consecutiveDatabaseFailures = 0;
  let circuitOpenUntil = 0;
  let databaseUnavailable = false;

  function requestMeta(input, init = {}) {
    try {
      const sourceUrl = typeof input === "string" || input instanceof URL
        ? input
        : input?.url || "";
      const url = new URL(sourceUrl, window.location.origin);
      const method = String(init.method || input?.method || "GET").toUpperCase();
      const sameOriginApi = url.origin === window.location.origin && url.pathname.startsWith("/api/");
      const body = typeof init.body === "string" ? init.body : "";
      return { url, method, body, sameOriginApi };
    } catch {
      return { url: null, method: "GET", body: "", sameOriginApi: false };
    }
  }

  function cacheTtl(pathname) {
    if (pathname === "/api/presence") return 2400;
    if (pathname === "/api/settings") return 30000;
    if (pathname === "/api/bootstrap") return 2500;
    if (pathname === "/api/messenger") return 1800;
    if (pathname === "/api/messages") return 1200;
    if (pathname.startsWith("/api/group-profile")) return 30000;
    if (pathname === "/api/push/public-key") return 10 * 60 * 1000;
    return 900;
  }

  function cacheKey(meta) {
    return `${meta.method}:${meta.url.pathname}${meta.url.search}`;
  }

  function writeKey(meta) {
    return `${meta.method}:${meta.url.pathname}:${meta.body}`;
  }

  function trimCache() {
    while (responseCache.size > MAX_CACHE_ENTRIES) {
      responseCache.delete(responseCache.keys().next().value);
    }
  }

  async function rememberResponse(key, response, ttl) {
    if (!response.ok) return;
    try {
      const clone = response.clone();
      const body = await clone.text();
      if (body.length > MAX_CACHE_BODY_BYTES) return;
      responseCache.delete(key);
      responseCache.set(key, {
        body,
        status: clone.status,
        statusText: clone.statusText,
        headers: [...clone.headers.entries()],
        storedAt: Date.now(),
        freshUntil: Date.now() + ttl
      });
      trimCache();
    } catch {
      // A response that cannot be cloned is still valid for its original caller.
    }
  }

  function cachedResponse(entry, stale = false) {
    const headers = new Headers(entry.headers);
    headers.set("X-YaChat-Cache", stale ? "stale" : "fresh");
    if (stale) headers.set("Warning", '110 - "Response is stale"');
    return new Response(entry.body, {
      status: entry.status,
      statusText: entry.statusText,
      headers
    });
  }

  function cachedRead(key, allowStale = false) {
    const entry = responseCache.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (entry.freshUntil >= now) return cachedResponse(entry, false);
    if (allowStale && now - entry.storedAt <= STALE_MAX_AGE_MS) return cachedResponse(entry, true);
    if (now - entry.storedAt > STALE_MAX_AGE_MS) responseCache.delete(key);
    return null;
  }

  function unavailableResponse() {
    return new Response(JSON.stringify({
      detail: "ЯЧат временно не может подключиться к базе данных. Повторите попытку позже.",
      code: "database_unavailable"
    }), {
      status: 503,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Retry-After": "15"
      }
    });
  }

  function setDatabaseUnavailable(value) {
    if (databaseUnavailable === value) return;
    databaseUnavailable = value;
    document.body?.classList.toggle("database-unavailable", value);
    window.dispatchEvent(new CustomEvent("yachat:database-status", {
      detail: { unavailable: value }
    }));
  }

  function noteSuccess() {
    consecutiveDatabaseFailures = 0;
    circuitOpenUntil = 0;
    setDatabaseUnavailable(false);
  }

  function noteFailure() {
    consecutiveDatabaseFailures += 1;
    const exponent = Math.max(0, consecutiveDatabaseFailures - 2);
    const pause = Math.min(60000, 2500 * (2 ** exponent));
    circuitOpenUntil = Date.now() + pause;
    setDatabaseUnavailable(true);
  }

  function isDatabaseFailure(response) {
    return [500, 502, 503, 504].includes(response?.status);
  }

  function fetchWithTimeout(input, init, timeoutMs) {
    const controller = new AbortController();
    const externalSignal = init?.signal || (input instanceof Request ? input.signal : null);
    let externalAbort = null;

    if (externalSignal) {
      externalAbort = () => controller.abort(externalSignal.reason);
      if (externalSignal.aborted) externalAbort();
      else externalSignal.addEventListener("abort", externalAbort, { once: true });
    }

    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    return originalFetch(input, { ...init, signal: controller.signal }).finally(() => {
      window.clearTimeout(timer);
      externalSignal?.removeEventListener?.("abort", externalAbort);
    });
  }

  function shortDelay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function readWithOneRetry(input, init) {
    let firstResponse = null;
    try {
      firstResponse = await fetchWithTimeout(input, init, READ_TIMEOUT_MS);
      if (!isDatabaseFailure(firstResponse)) return firstResponse;
    } catch {
      // A single retry below absorbs transient Supavisor/serverless wake-ups.
    }

    await shortDelay(180 + Math.floor(Math.random() * 120));
    try {
      return await fetchWithTimeout(input, init, READ_TIMEOUT_MS);
    } catch {
      if (firstResponse) return firstResponse;
      throw new Error("YaChat API read failed after retry.");
    }
  }

  function invalidateReadsAfterWrite(pathname) {
    if (pathname === "/api/settings") {
      for (const key of [...responseCache.keys()]) {
        if (key.startsWith("GET:/api/settings")) responseCache.delete(key);
      }
      return;
    }
    for (const key of [...responseCache.keys()]) {
      if (
        key.startsWith("GET:/api/bootstrap")
        || key.startsWith("GET:/api/messenger")
        || key.startsWith("GET:/api/messages")
        || key.startsWith("GET:/api/presence")
        || key.startsWith("GET:/api/group-profile")
      ) {
        responseCache.delete(key);
      }
    }
  }

  function performRead(input, init, meta, key) {
    const existing = inFlightReads.get(key);
    if (existing) return existing.then((response) => response.clone());

    const request = readWithOneRetry(input, init)
      .then(async (response) => {
        if (isDatabaseFailure(response)) {
          noteFailure();
          return cachedRead(key, true) || response;
        }
        if (response.ok) {
          noteSuccess();
          await rememberResponse(key, response, cacheTtl(meta.url.pathname));
        }
        return response;
      })
      .catch(() => {
        noteFailure();
        return cachedRead(key, true) || unavailableResponse();
      })
      .finally(() => {
        inFlightReads.delete(key);
      });

    inFlightReads.set(key, request);
    return request.then((response) => response.clone());
  }

  async function performWrite(input, init, meta) {
    const key = writeKey(meta);
    const isSettingsWrite = meta.url.pathname === "/api/settings" && meta.method === "POST";
    const previous = isSettingsWrite ? recentIdempotentWrites.get(key) : null;
    if (previous && Date.now() - previous.storedAt <= SETTINGS_WRITE_DEDUP_MS) {
      return cachedResponse(previous.response, false);
    }

    if (Date.now() < circuitOpenUntil) return unavailableResponse();

    try {
      const response = await fetchWithTimeout(input, init, WRITE_TIMEOUT_MS);
      if (isDatabaseFailure(response)) {
        noteFailure();
        return response;
      }
      if (response.ok) {
        noteSuccess();
        invalidateReadsAfterWrite(meta.url.pathname);
        if (isSettingsWrite) {
          const clone = response.clone();
          const body = await clone.text();
          if (body.length <= MAX_CACHE_BODY_BYTES) {
            recentIdempotentWrites.clear();
            recentIdempotentWrites.set(key, {
              storedAt: Date.now(),
              response: {
                body,
                status: clone.status,
                statusText: clone.statusText,
                headers: [...clone.headers.entries()]
              }
            });
          }
        }
      }
      return response;
    } catch {
      noteFailure();
      return unavailableResponse();
    }
  }

  window.fetch = function resilientApiFetch(input, init = {}) {
    const meta = requestMeta(input, init);
    if (!meta.sameOriginApi) return originalFetch(input, init);

    if (meta.method === "GET" || meta.method === "HEAD") {
      const key = cacheKey(meta);
      const fresh = cachedRead(key, false);
      if (fresh) return Promise.resolve(fresh);
      if (Date.now() < circuitOpenUntil) {
        return Promise.resolve(cachedRead(key, true) || unavailableResponse());
      }
      return performRead(input, init, meta, key);
    }

    return performWrite(input, init, meta);
  };
})();

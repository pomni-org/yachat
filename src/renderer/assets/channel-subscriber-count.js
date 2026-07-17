(() => {
  "use strict";

  const CHANNEL_ID = "yachat-channel";
  const CACHE_MS = 30000;
  const nativeFetch = window.fetch.bind(window);
  let cachedCount = null;
  let cachedAt = 0;
  let countRequest = null;

  function requestUrl(input) {
    try {
      const source = typeof input === "string" || input instanceof URL
        ? String(input)
        : input?.url || "";
      return new URL(source, window.location.href);
    } catch {
      return null;
    }
  }

  async function loadSubscriberCount() {
    if (cachedCount !== null && Date.now() - cachedAt < CACHE_MS) {
      return cachedCount;
    }
    if (countRequest) {
      return countRequest;
    }

    countRequest = (async () => {
      try {
        const token = localStorage.getItem("yachat-http-auth-token") || "";
        const response = await nativeFetch("/api/users", {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: "no-store"
        });
        if (!response.ok) {
          throw new Error("Could not load subscribers");
        }

        const users = await response.json();
        if (!Array.isArray(users)) {
          throw new Error("Invalid subscribers response");
        }

        cachedCount = new Set(
          users
            .map((user) => String(user?.id || "").trim())
            .filter(Boolean)
        ).size;
        cachedAt = Date.now();

        try {
          const channel = Array.isArray(state?.chats)
            ? state.chats.find((chat) => chat?.id === CHANNEL_ID)
            : null;
          if (channel) {
            channel.subscriberCount = cachedCount;
          }
        } catch {
          // The intercepted presence response still carries the correct count.
        }

        return cachedCount;
      } catch {
        return cachedCount;
      } finally {
        countRequest = null;
      }
    })();

    return countRequest;
  }

  window.fetch = async function yachatFetchWithChannelCount(input, init) {
    const response = await nativeFetch(input, init);
    const url = requestUrl(input);
    const isChannelPresence = url?.pathname === "/api/presence"
      && url.searchParams.get("chatId") === CHANNEL_ID;

    if (!isChannelPresence || !response.ok) {
      return response;
    }

    try {
      const payload = await response.clone().json();
      const accountCount = await loadSubscriberCount();
      if (accountCount === null) {
        return response;
      }

      payload.subscriberCount = Math.max(
        Number.parseInt(payload.subscriberCount, 10) || 0,
        accountCount
      );

      return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch {
      return response;
    }
  };

  void loadSubscriberCount();
})();

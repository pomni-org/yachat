(() => {
  "use strict";

  if (window.__yachatBootstrapQuickBridgeInstalled) return;
  window.__yachatBootstrapQuickBridgeInstalled = true;

  const originalFetch = window.fetch.bind(window);

  function jsonResponse(payload) {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store"
      }
    });
  }

  function sharedGetOptions(init = {}) {
    return {
      method: "GET",
      headers: init.headers,
      credentials: init.credentials,
      mode: init.mode,
      cache: "no-store",
      redirect: init.redirect,
      referrer: init.referrer,
      referrerPolicy: init.referrerPolicy,
      signal: init.signal
    };
  }

  async function readJson(response) {
    if (!response?.ok) throw new Error(`Bootstrap dependency failed: ${response?.status || 0}`);
    return response.json();
  }

  function chooseActiveChat(chats, requestedChatId, routeUser) {
    const list = Array.isArray(chats) ? chats : [];
    const requested = String(requestedChatId || "");
    if (requested && list.some((chat) => String(chat?.id || "") === requested)) {
      return requested;
    }

    const routeUserId = String(routeUser?.id || "");
    if (routeUserId) {
      const routeChat = list.find((chat) => (
        chat?.kind === "private"
        && Array.isArray(chat.participantIds)
        && chat.participantIds.some((id) => String(id || "") === routeUserId)
      ));
      if (routeChat?.id) return String(routeChat.id);
    }

    return String(list[0]?.id || "");
  }

  async function buildQuickBootstrap(originalUrl, init) {
    const requestOptions = sharedGetOptions(init);
    const username = String(originalUrl.searchParams.get("username") || "").trim();
    const accountRequest = originalFetch("/api/account", requestOptions);
    const settingsRequest = originalFetch("/api/settings", requestOptions);
    const chatsRequest = originalFetch("/api/chats", requestOptions);
    const routeUserRequest = username
      ? originalFetch(`/api/users/by-username?username=${encodeURIComponent(username)}`, requestOptions)
      : Promise.resolve(null);

    const [accountResponse, settingsResponse, chatsResponse, routeUserResponse] = await Promise.all([
      accountRequest,
      settingsRequest,
      chatsRequest,
      routeUserRequest
    ]);

    const account = await readJson(accountResponse);
    const settings = settingsResponse?.ok ? await settingsResponse.json() : {};
    const chats = await readJson(chatsResponse);
    const routeUser = routeUserResponse?.ok ? await routeUserResponse.json() : null;
    const activeChatId = chooseActiveChat(
      chats,
      originalUrl.searchParams.get("chatId"),
      routeUser
    );

    return {
      authenticated: Boolean(account),
      account: account || null,
      settings: settings || {},
      chats: Array.isArray(chats) ? chats : [],
      messages: [],
      activeChatId: activeChatId || null,
      routeUser: routeUser || null,
      optimized: true,
      deferredMessages: true
    };
  }

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
        try {
          const payload = await buildQuickBootstrap(originalUrl, init);
          window.__yachatQuickBootstrapUsed = true;
          return jsonResponse(payload);
        } catch {
          return originalFetch(input, init);
        }
      }
    } catch {
      // The original request remains the safest fallback for malformed input.
    }

    return originalFetch(input, init);
  };
})();

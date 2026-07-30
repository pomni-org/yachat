(() => {
  "use strict";

  if (
    window.__yachatWebSocketRealtimeInstalled
    || typeof state === "undefined"
    || typeof yachatApi === "undefined"
    || !yachatApi?.messenger
  ) {
    return;
  }
  window.__yachatWebSocketRealtimeInstalled = true;

  const AUTH_TOKEN_KEY = "yachat-http-auth-token";
  const COMMAND_TIMEOUT_MS = 22000;
  const HEARTBEAT_MS = 25000;
  const FALLBACK_POLL_MS = 30000;
  const FALLBACK_AFTER_FAILURES = 3;
  const MAX_RECONNECT_MS = 20000;
  const MAX_CHUNK_COUNT = 2048;
  const MAX_CHUNKED_MESSAGE_CHARS = 64 * 1024 * 1024;
  const CHUNK_TIMEOUT_MS = 45000;

  const supported = (
    typeof WebSocket === "function"
    && ["http:", "https:"].includes(window.location.protocol)
  );
  const pending = new Map();
  const chunkedMessages = new Map();
  let socket = null;
  let phase = supported ? "idle" : "unsupported";
  let readyAcknowledged = false;
  let intentionalClose = false;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let requestSequence = 0;
  let connectionGeneration = 0;
  let failureCount = 0;
  let pushedSnapshot = null;
  let pushDrainPromise = null;
  let pushedSnapshotChain = Promise.resolve();
  let consumingPushedSnapshot = false;

  const originalSnapshot = typeof yachatApi.messenger.snapshot === "function"
    ? yachatApi.messenger.snapshot.bind(yachatApi.messenger)
    : null;
  const originalChats = typeof yachatApi.messenger.chats === "function"
    ? yachatApi.messenger.chats.bind(yachatApi.messenger)
    : null;
  const originalMessages = typeof yachatApi.messenger.messages === "function"
    ? yachatApi.messenger.messages.bind(yachatApi.messenger)
    : null;
  const originalMarkRead = typeof yachatApi.messenger.markRead === "function"
    ? yachatApi.messenger.markRead.bind(yachatApi.messenger)
    : null;

  function authToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY) || "";
  }

  function hasSession() {
    return Boolean(authToken() && state?.account);
  }

  function commandReady() {
    return Boolean(
      readyAcknowledged
      && socket
      && socket.readyState === WebSocket.OPEN
    );
  }

  function shouldPoll() {
    if (!supported || !hasSession()) {
      return Boolean(state?.account);
    }
    if (!navigator.onLine || phase === "unauthorized") {
      return false;
    }
    return phase === "degraded" || failureCount >= FALLBACK_AFTER_FAILURES;
  }

  function emit(name, detail = {}) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function publishStatus(nextPhase = phase) {
    phase = nextPhase;
    emit("yachat:realtime-status", {
      status: phase,
      connected: commandReady(),
      shouldPoll: shouldPoll()
    });
  }

  function stopFallbackPolling() {
    try {
      stopMessengerPolling?.();
    } catch {
      // The socket remains useful even when the legacy fallback is unavailable.
    }
  }

  function startFallbackPolling() {
    if (!shouldPoll()) {
      return;
    }
    try {
      startMessengerPolling?.();
    } catch {
      // A failed fallback must not close an otherwise usable WebSocket.
    }
  }

  function realtimeError(message, status = 503) {
    const error = new Error(message);
    error.status = status;
    error.code = "REALTIME_UNAVAILABLE";
    return error;
  }

  function rejectPending(error) {
    for (const entry of pending.values()) {
      window.clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function websocketUrl() {
    const url = new URL("/api/realtime", window.location.origin);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }

  function clearConnectionTimers() {
    window.clearTimeout(reconnectTimer);
    window.clearInterval(heartbeatTimer);
    reconnectTimer = null;
    heartbeatTimer = null;
    for (const entry of chunkedMessages.values()) {
      window.clearTimeout(entry.timer);
    }
    chunkedMessages.clear();
  }

  function scheduleReconnect() {
    if (
      intentionalClose
      || !supported
      || !hasSession()
      || !navigator.onLine
      || phase === "unauthorized"
    ) {
      return;
    }
    window.clearTimeout(reconnectTimer);
    const exponent = Math.max(0, failureCount - 1);
    const delay = Math.min(MAX_RECONNECT_MS, 700 * (2 ** exponent));
    reconnectTimer = window.setTimeout(connect, delay);
  }

  function sendFrame(frame) {
    if (!commandReady()) {
      throw realtimeError("Realtime connection is not ready.");
    }
    socket.send(JSON.stringify(frame));
  }

  function command(action, payload = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (!commandReady()) {
      return Promise.reject(realtimeError("Realtime connection is not ready."));
    }

    const id = `rt-${Date.now().toString(36)}-${(++requestSequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id);
        reject(realtimeError("Realtime operation timed out.", 504));
      }, timeoutMs);
      pending.set(id, {
        resolve,
        reject,
        timer,
        action,
        generation: connectionGeneration
      });
      try {
        sendFrame({
          type: "command",
          id,
          action,
          payload: payload && typeof payload === "object" ? payload : {}
        });
      } catch (error) {
        window.clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  async function decodeResponse(payload) {
    const decoder = window.__yachatE2EETransport?.decodeResponse;
    if (typeof decoder !== "function") {
      return payload;
    }
    try {
      return await decoder(payload);
    } catch {
      return payload;
    }
  }

  async function resolveResponse(frame) {
    const id = String(frame?.id || "");
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id);
    window.clearTimeout(entry.timer);
    if (frame.ok) {
      const shouldDecode = ["snapshot", "sync", "chats", "messages", "mark_read"]
        .includes(entry.action);
      const data = shouldDecode ? await decodeResponse(frame.data) : frame.data;
      if (entry.generation !== connectionGeneration || !commandReady()) {
        entry.reject(realtimeError("Realtime connection changed."));
        return;
      }
      entry.resolve(data);
      return;
    }
    const error = realtimeError(
      String(frame.error || "Realtime operation failed."),
      Number(frame.status || 500)
    );
    entry.reject(error);
  }

  async function drainPushedSnapshots() {
    if (pushDrainPromise || !pushedSnapshot) {
      return pushDrainPromise;
    }
    pushDrainPromise = (async () => {
      while (pushedSnapshot) {
        const expected = pushedSnapshot;
        try {
          if (typeof refreshMessengerFromServer === "function" && state?.account) {
            consumingPushedSnapshot = true;
            await refreshMessengerFromServer();
          } else if (typeof applyMessengerSnapshot === "function" && state?.account) {
            pushedSnapshot = null;
            await applyMessengerSnapshot(
              expected,
              state.activeChatId,
              { followRoute: false }
            );
          } else {
            pushedSnapshot = null;
          }
        } catch {
          if (pushedSnapshot === expected) {
            pushedSnapshot = null;
          }
        } finally {
          consumingPushedSnapshot = false;
        }
        if (pushedSnapshot === expected) {
          pushedSnapshot = null;
        }
      }
    })().finally(() => {
      pushDrainPromise = null;
      if (pushedSnapshot) {
        void drainPushedSnapshots();
      }
    });
    return pushDrainPromise;
  }

  function queuePushedSnapshot(loadSnapshot, generation) {
    pushedSnapshotChain = pushedSnapshotChain
      .then(async () => {
        const snapshot = await loadSnapshot();
        if (generation !== connectionGeneration || !commandReady()) {
          return;
        }
        pushedSnapshot = snapshot;
        await drainPushedSnapshots();
      })
      .catch(() => {});
    return pushedSnapshotChain;
  }

  function handleEvent(frame, generation) {
    const eventName = String(frame?.event || "");
    const data = frame?.data && typeof frame.data === "object" ? frame.data : {};
    if (eventName === "snapshot") {
      void queuePushedSnapshot(() => decodeResponse(data), generation);
      return;
    }
    if (eventName === "chats") {
      void queuePushedSnapshot(async () => ({
        chats: await decodeResponse(Array.isArray(data) ? data : []),
        activeChatId: String(state?.activeChatId || ""),
        messages: Array.isArray(state?.messages) ? [...state.messages] : []
      }), generation);
      return;
    }
    if (eventName === "presence") {
      emit("yachat:realtime-presence", data);
      return;
    }
    if (eventName === "typing") {
      emit("yachat:realtime-typing", data);
      return;
    }
    if (eventName === "status") {
      const upstreamStatus = String(data.status || "");
      if (upstreamStatus === "ready") {
        failureCount = 0;
        publishStatus("ready");
        stopFallbackPolling();
      } else if (upstreamStatus === "degraded") {
        publishStatus("degraded");
        startFallbackPolling();
      }
    }
  }

  function startHeartbeat() {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = window.setInterval(() => {
      if (!commandReady()) {
        return;
      }
      void command("ping", {}, 8000).catch(() => {
        try {
          socket?.close(1012, "heartbeat-timeout");
        } catch {
          // The reconnect handler will recover once the browser reports closure.
        }
      });
    }, HEARTBEAT_MS);
  }

  function handleChunk(frame, generation) {
    const chunkId = String(frame?.chunkId || "").slice(0, 100);
    const index = Number(frame?.index);
    const total = Number(frame?.total);
    const data = typeof frame?.data === "string" ? frame.data : "";
    if (
      !chunkId
      || !Number.isInteger(index)
      || !Number.isInteger(total)
      || total < 1
      || total > MAX_CHUNK_COUNT
      || index < 0
      || index >= total
    ) {
      return;
    }

    let entry = chunkedMessages.get(chunkId);
    if (!entry) {
      const timer = window.setTimeout(() => {
        chunkedMessages.delete(chunkId);
      }, CHUNK_TIMEOUT_MS);
      entry = {
        total,
        parts: new Array(total),
        received: 0,
        size: 0,
        timer
      };
      chunkedMessages.set(chunkId, entry);
    }
    if (entry.total !== total || entry.parts[index] !== undefined) {
      return;
    }
    entry.parts[index] = data;
    entry.received += 1;
    entry.size += data.length;
    if (entry.size > MAX_CHUNKED_MESSAGE_CHARS) {
      window.clearTimeout(entry.timer);
      chunkedMessages.delete(chunkId);
      socket?.close(1009, "realtime-payload-too-large");
      return;
    }
    if (entry.received !== entry.total) {
      return;
    }

    window.clearTimeout(entry.timer);
    chunkedMessages.delete(chunkId);
    try {
      handleFrame(JSON.parse(entry.parts.join("")), generation);
    } catch {
      socket?.close(1007, "invalid-realtime-payload");
    }
  }

  function handleFrame(frame, generation) {
    if (generation !== connectionGeneration) {
      return;
    }
    if (!frame || typeof frame !== "object") {
      return;
    }
    if (frame.type === "chunk") {
      handleChunk(frame, generation);
      return;
    }
    if (frame.type === "ready") {
      readyAcknowledged = true;
      const realtimeStatus = String(frame.realtimeStatus || "connected");
      publishStatus(realtimeStatus === "ready" ? "ready" : realtimeStatus);
      if (realtimeStatus === "degraded") {
        startFallbackPolling();
      } else {
        stopFallbackPolling();
      }
      startHeartbeat();
      void command("snapshot", {
        chatId: String(state?.activeChatId || ""),
        username: ""
      }).then((snapshot) => {
        void queuePushedSnapshot(() => snapshot, generation);
      }).catch(() => {});
      return;
    }
    if (frame.type === "response") {
      void resolveResponse(frame);
      return;
    }
    if (frame.type === "event") {
      handleEvent(frame, generation);
      return;
    }
    if (frame.type === "error" && Number(frame.status || 0) === 401) {
      publishStatus("unauthorized");
      socket?.close(4401, "session-expired");
    }
  }

  function handleMessage(event, generation) {
    let frame;
    try {
      frame = JSON.parse(String(event.data || ""));
    } catch {
      return;
    }
    handleFrame(frame, generation);
  }

  function connect() {
    if (!supported || !hasSession() || !navigator.onLine) {
      return;
    }
    if (
      socket
      && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)
    ) {
      return;
    }

    intentionalClose = false;
    readyAcknowledged = false;
    const generation = ++connectionGeneration;
    publishStatus("connecting");
    stopFallbackPolling();

    try {
      socket = new WebSocket(websocketUrl());
    } catch {
      failureCount += 1;
      publishStatus("reconnecting");
      startFallbackPolling();
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      if (generation !== connectionGeneration) {
        return;
      }
      socket.send(JSON.stringify({
        type: "auth",
        token: authToken()
      }));
    });

    socket.addEventListener("message", (event) => handleMessage(event, generation));

    socket.addEventListener("close", (event) => {
      if (generation !== connectionGeneration) {
        return;
      }
      clearConnectionTimers();
      readyAcknowledged = false;
      socket = null;
      rejectPending(realtimeError("Realtime connection closed."));
      if (intentionalClose) {
        publishStatus(hasSession() ? "idle" : "closed");
        return;
      }
      if (event.code === 4401) {
        publishStatus("unauthorized");
        return;
      }
      failureCount += 1;
      publishStatus("reconnecting");
      startFallbackPolling();
      scheduleReconnect();
    });
  }

  function disconnect(reason = "session-ended") {
    intentionalClose = true;
    connectionGeneration += 1;
    clearConnectionTimers();
    readyAcknowledged = false;
    rejectPending(realtimeError("Realtime session ended.", 401));
    if (socket && socket.readyState < WebSocket.CLOSING) {
      try {
        socket.close(1000, reason.slice(0, 100));
      } catch {
        // Closing a stale browser socket is best-effort.
      }
    }
    socket = null;
    failureCount = 0;
    publishStatus(hasSession() ? "idle" : "closed");
  }

  async function withHttpFallback(realtimeAction, httpAction) {
    if (!commandReady()) {
      return httpAction();
    }
    try {
      return await realtimeAction();
    } catch (error) {
      const status = Number(error?.status || 0);
      if (status >= 400 && status < 500) {
        throw error;
      }
      return httpAction();
    }
  }

  if (originalSnapshot) {
    yachatApi.messenger.snapshot = (params = {}) => {
      if (consumingPushedSnapshot && pushedSnapshot) {
        const snapshot = pushedSnapshot;
        pushedSnapshot = null;
        return Promise.resolve(snapshot);
      }
      return withHttpFallback(
        () => command("snapshot", params),
        () => originalSnapshot(params)
      );
    };
  }

  if (originalChats) {
    yachatApi.messenger.chats = () => withHttpFallback(
      () => command("chats"),
      () => originalChats()
    );
  }

  if (originalMessages) {
    yachatApi.messenger.messages = (chatId) => withHttpFallback(
      () => command("messages", { chatId: String(chatId || ""), limit: 80 }),
      () => originalMessages(chatId)
    );
  }

  if (originalMarkRead) {
    yachatApi.messenger.markRead = (payload = {}) => withHttpFallback(
      () => command("mark_read", payload),
      () => originalMarkRead(payload)
    );
  }

  if (typeof messengerPollDelay === "function") {
    const inheritedMessengerPollDelay = messengerPollDelay;
    messengerPollDelay = function realtimeFallbackPollDelay() {
      const inherited = Number(inheritedMessengerPollDelay()) || FALLBACK_POLL_MS;
      return supported && hasSession()
        ? Math.max(FALLBACK_POLL_MS, inherited)
        : inherited;
    };
  }

  if (typeof showMessenger === "function") {
    const inheritedShowMessenger = showMessenger;
    showMessenger = async function showMessengerWithRealtime(account, options = {}) {
      window.setTimeout(connect, 0);
      const result = await inheritedShowMessenger(account, options);
      connect();
      return result;
    };
  }

  if (typeof selectChat === "function") {
    const inheritedSelectChat = selectChat;
    selectChat = function selectChatWithRealtime(chatId, options = {}) {
      if (commandReady()) {
        void command("set_active", { chatId: String(chatId || "") }).catch(() => {});
      }
      return inheritedSelectChat(chatId, options);
    };
  }

  if (typeof resetAccountSessionUi === "function") {
    const inheritedResetAccountSessionUi = resetAccountSessionUi;
    resetAccountSessionUi = function resetAccountSessionUiWithRealtime(...args) {
      disconnect("session-ended");
      return inheritedResetAccountSessionUi(...args);
    };
  }

  window.yachatRealtime = Object.freeze({
    connect,
    disconnect,
    ensureConnected: connect,
    isReady: commandReady,
    isEnabled: () => supported && hasSession(),
    shouldPoll,
    fallbackPollMs: FALLBACK_POLL_MS,
    status: () => phase,
    request: command,
    setActive: (chatId) => command("set_active", { chatId: String(chatId || "") }),
    typing: (chatId, typing) => command("typing", {
      chatId: String(chatId || ""),
      typing: Boolean(typing)
    })
  });

  window.addEventListener("online", connect);
  window.addEventListener("offline", () => {
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1001, "offline");
    }
    publishStatus("offline");
  });
  window.addEventListener("pageshow", connect);
  window.addEventListener("pagehide", () => disconnect("page-hidden"));

  if (hasSession()) {
    connect();
  } else {
    publishStatus(phase);
  }
})();

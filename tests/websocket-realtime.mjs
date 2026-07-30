import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [
  runtime,
  app,
  presence,
  typingFix,
  migration,
  vercel,
  requirements,
  e2ee,
  realtimeServer
] = await Promise.all([
  readFile(new URL("../src/renderer/assets/websocket-realtime.js", import.meta.url), "utf8"),
  readFile(new URL("../src/renderer/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/renderer/assets/chat-presence.js", import.meta.url), "utf8"),
  readFile(new URL("../src/renderer/assets/typing-stop-fix.js", import.meta.url), "utf8"),
  readFile(
    new URL(
      "../supabase/migrations/20260730060733_websocket_realtime_transport.sql",
      import.meta.url
    ),
    "utf8"
  ),
  readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  readFile(new URL("../requirements.txt", import.meta.url), "utf8"),
  readFile(new URL("../src/renderer/assets/e2ee-phase2.js", import.meta.url), "utf8"),
  readFile(new URL("../server/realtime_gateway.py", import.meta.url), "utf8")
]);

assert.match(runtime, /new WebSocket\(websocketUrl\(\)\)/);
assert.match(runtime, /type:\s*"auth",\s*token:\s*authToken\(\)/);
assert.doesNotMatch(runtime, /searchParams\.set\([^)]*token/i);
assert.match(runtime, /command\("snapshot"/);
assert.match(runtime, /command\("chats"/);
assert.match(runtime, /command\("messages"/);
assert.match(runtime, /command\("mark_read"/);
assert.match(runtime, /command\("typing"/);
assert.match(runtime, /FALLBACK_POLL_MS\s*=\s*30000/);
assert.match(runtime, /MAX_CHUNKED_MESSAGE_CHARS\s*=\s*64\s*\*\s*1024\s*\*\s*1024/);
assert.match(runtime, /frame\.type === "chunk"/);
assert.match(runtime, /window\.__yachatE2EETransport\?\.decodeResponse/);
assert.match(runtime, /pushedSnapshotChain = pushedSnapshotChain/);
assert.match(e2ee, /window\.__yachatE2EETransport = Object\.freeze\(\{/);
assert.match(e2ee, /decodeResponse:\s*\(payload\) => decryptResponsePayload\(payload\)/);
assert.match(e2ee, /ensureDecryptionRecord\(payloadAccountId\)/);
assert.match(e2ee, /payload\.account\.id/);
assert.match(e2ee, /lastMessageData/);
assert.match(e2ee, /metadataOnlyAttachments:\s*true/);
assert.match(realtimeServer, /"realtimeStatus":\s*"connecting"/);
assert.doesNotMatch(realtimeServer, /wait_for\(\s*gateway\.upstream_ready\.wait\(\)/);
assert.match(realtimeServer, /"mark_read"[\s\S]*?"readAt":\s*datetime\.now/);
assert.match(app, /window\.yachatRealtime\?\.isEnabled\?\.\(\)/);
assert.match(app, /window\.yachatRealtime\.shouldPoll\(\)/);
assert.doesNotMatch(presence, /PRESENCE_POLL_MS\s*=\s*600/);
assert.doesNotMatch(presence, /PRESENCE_BACKGROUND_POLL_MS\s*=\s*4000/);
assert.match(presence, /yachat:realtime-presence/);
assert.match(presence, /yachat:realtime-typing/);
assert.match(presence, /window\.yachatRealtime\.typing/);
assert.match(typingFix, /window\.yachatRealtime\.typing\(chatId,\s*false\)/);

assert.match(migration, /perform realtime\.send\(/);
assert.match(migration, /realtime_event_key/);
assert.match(migration, /realtime_topic_key/);
assert.match(migration, /from public, anon, authenticated/);
assert.match(migration, /jsonb_build_object\(\s*'entity', 'message'/);
assert.match(migration, /'entity', 'account_ban'/);
assert.match(migration, /after insert or delete or update of role/);
assert.match(migration, /yachat_account_bans_realtime_changed/);
assert.doesNotMatch(migration, /new\.(?:text|formatted_html|attachments)/i);
assert.doesNotMatch(migration, /old\.(?:text|formatted_html|attachments)/i);
const messageTrigger = migration.match(
  /create or replace function public\.yachat_realtime_message_changed\(\)[\s\S]*?\n\$\$;/
)?.[0] || "";
assert.match(messageTrigger, /yachat_realtime_emit_chat/);
assert.doesNotMatch(messageTrigger, /for\s+\w+\s+in/i);

const vercelConfig = JSON.parse(vercel);
assert.equal(vercelConfig.fluid, true);
assert.deepEqual(
  vercelConfig.rewrites.find((entry) => entry.source === "/api/realtime"),
  { source: "/api/realtime", destination: "/api/presence_runtime.py" }
);
assert.equal(vercelConfig.functions["api/presence_runtime.py"].maxDuration, 300);
assert.equal(vercelConfig.functions["api/realtime.py"], undefined);
assert.ok(
  Object.keys(vercelConfig.functions).length <= 12,
  "the Hobby deployment must stay within the 12-function limit"
);
assert.match(requirements, /^fastapi==0\.137\.0$/m);
assert.match(requirements, /^realtime==2\.31\.0$/m);
assert.match(requirements, /^uvicorn\[standard\]==0\.49\.0$/m);

class EventHub {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) {
      listener(event);
    }
  }
}

class FakeWebSocket extends EventHub {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.frames = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent({ type: "open" });
  }

  send(value) {
    this.frames.push(JSON.parse(String(value)));
  }

  receive(value) {
    this.dispatchEvent({ type: "message", data: JSON.stringify(value) });
  }

  close(code = 1000) {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent({ type: "close", code });
  }
}

const documentHub = new EventHub();
const windowHub = new EventHub();
const token = "session-token-never-in-url";
let httpMessages = 0;
let httpSnapshots = 0;
let refreshes = 0;
let stoppedPolls = 0;
let timerId = 0;
let decodedResponses = 0;
const storage = new Map([["yachat-http-auth-token", token]]);
const context = {
  WebSocket: FakeWebSocket,
  CustomEvent: class {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  },
  URL,
  Promise,
  Map,
  Object,
  Error,
  JSON,
  Date,
  Math,
  Number,
  String,
  Boolean,
  Array,
  navigator: { onLine: true },
  location: {
    protocol: "https:",
    origin: "https://yachat.eu.org"
  },
  localStorage: {
    getItem: (key) => storage.get(key) || "",
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  },
  document: documentHub,
  state: {
    account: { id: "self" },
    activeChatId: "private-11111111111111111111111111111111"
  },
  __yachatE2EETransport: {
    decodeResponse: async (payload) => {
      decodedResponses += 1;
      if (Array.isArray(payload)) {
        return payload.map((item) => ({ ...item, decoded: true }));
      }
      return {
        ...payload,
        decoded: true,
        messages: Array.isArray(payload?.messages)
          ? payload.messages.map((item) => ({ ...item, decoded: true }))
          : payload?.messages
      };
    }
  },
  yachatApi: {
    messenger: {
      snapshot: async () => {
        httpSnapshots += 1;
        return {};
      },
      chats: async () => [],
      messages: async () => {
        httpMessages += 1;
        return [];
      },
      markRead: async () => ({})
    }
  },
  refreshMessengerFromServer: async () => {
    const snapshot = await context.yachatApi.messenger.snapshot({
      chatId: context.state.activeChatId
    });
    context.state.lastSnapshot = snapshot;
    refreshes += 1;
  },
  messengerPollDelay: () => 450,
  stopMessengerPolling: () => {
    stoppedPolls += 1;
  },
  startMessengerPolling() {},
  showMessenger: async () => {},
  selectChat: async () => {},
  resetAccountSessionUi() {},
  setTimeout: (callback, delay) => {
    timerId += 1;
    if (Number(delay) === 0) queueMicrotask(callback);
    return timerId;
  },
  clearTimeout() {},
  setInterval: () => ++timerId,
  clearInterval() {},
  queueMicrotask
};
Object.assign(context.document, {
  visibilityState: "visible"
});
Object.assign(context, {
  addEventListener: windowHub.addEventListener.bind(windowHub),
  dispatchEvent: windowHub.dispatchEvent.bind(windowHub)
});
context.window = context;

vm.runInNewContext(runtime, context, { filename: "websocket-realtime.js" });
assert.equal(FakeWebSocket.instances.length, 1);
const websocket = FakeWebSocket.instances[0];
assert.equal(websocket.url, "wss://yachat.eu.org/api/realtime");
assert.ok(!websocket.url.includes(token));

websocket.open();
assert.deepEqual(
  JSON.parse(JSON.stringify(websocket.frames[0])),
  { type: "auth", token }
);
websocket.receive({ type: "ready", protocol: 1, transport: "websocket" });
const initialSnapshotFrame = websocket.frames.find((frame) => frame.action === "snapshot");
assert.ok(initialSnapshotFrame);
websocket.receive({
  type: "response",
  id: initialSnapshotFrame.id,
  ok: true,
  data: {
    chats: [],
    messages: [{ id: "message-1" }],
    activeChatId: context.state.activeChatId
  }
});
websocket.receive({
  type: "event",
  event: "status",
  data: { status: "ready" }
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(httpSnapshots, 0);
assert.equal(refreshes, 1);
assert.ok(stoppedPolls > 0);
assert.equal(context.state.lastSnapshot.decoded, true);
assert.equal(context.state.lastSnapshot.messages[0].decoded, true);

const messagesPromise = context.yachatApi.messenger.messages(context.state.activeChatId);
const messagesFrame = websocket.frames.findLast((frame) => frame.action === "messages");
assert.ok(messagesFrame);
websocket.receive({
  type: "response",
  id: messagesFrame.id,
  ok: true,
  data: [{ id: "message-2" }]
});
assert.deepEqual(
  JSON.parse(JSON.stringify(await messagesPromise)),
  [{ id: "message-2", decoded: true }]
);
assert.equal(httpMessages, 0);
assert.ok(decodedResponses >= 2);

const chatsPromise = context.yachatApi.messenger.chats();
const chatsFrame = websocket.frames.findLast((frame) => frame.action === "chats");
const chunkedResponse = JSON.stringify({
  type: "response",
  id: chatsFrame.id,
  ok: true,
  data: [{ id: "private-22222222222222222222222222222222" }]
});
const chunkBoundary = Math.floor(chunkedResponse.length / 2);
websocket.receive({
  type: "chunk",
  chunkId: "chunk-test",
  index: 0,
  total: 2,
  data: chunkedResponse.slice(0, chunkBoundary)
});
websocket.receive({
  type: "chunk",
  chunkId: "chunk-test",
  index: 1,
  total: 2,
  data: chunkedResponse.slice(chunkBoundary)
});
const decodedChats = await chatsPromise;
assert.equal(decodedChats[0].id, "private-22222222222222222222222222222222");
assert.equal(decodedChats[0].decoded, true);

const typingPromise = context.window.yachatRealtime.typing(context.state.activeChatId, true);
const typingFrame = websocket.frames.findLast((frame) => frame.action === "typing");
assert.ok(typingFrame);
websocket.receive({
  type: "response",
  id: typingFrame.id,
  ok: true,
  data: { ok: true, typing: true }
});
assert.equal((await typingPromise).typing, true);

console.log("websocket realtime regression passed");

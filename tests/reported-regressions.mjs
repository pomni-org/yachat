import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [app, api, e2ee, groupFlow] = await Promise.all([
  readFile(new URL("../src/renderer/app.js", import.meta.url), "utf8"),
  readFile(new URL("../api/index.py", import.meta.url), "utf8"),
  readFile(new URL("../src/renderer/assets/e2ee-phase2.js", import.meta.url), "utf8"),
  readFile(new URL("../src/renderer/assets/group-creation-flow.js", import.meta.url), "utf8")
]);

function numberFrom(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `${label} is missing`);
  return Number(match[1].replaceAll("_", ""));
}

const rawVideoLimit = numberFrom(
  app,
  /DOCUMENT_TRANSPORT_LIMIT_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/,
  "raw attachment limit"
) * 1024 * 1024;
const clientDataUrlLimit = numberFrom(
  app,
  /ATTACHMENT_DATA_URL_LIMIT_CHARS\s*=\s*([\d_]+)/,
  "client data URL limit"
);
const serverDataUrlLimit = numberFrom(
  api,
  /YACHAT_MAX_ATTACHMENT_DATA_URL_BYTES",\s*"([\d_]+)"/,
  "server data URL limit"
);
const e2eeDataUrlLimit = numberFrom(
  e2ee,
  /MAX_ATTACHMENT_DATA_URL_CHARS\s*=\s*([\d_]+)/,
  "E2EE data URL limit"
);
const encryptedVideoDataUrlLength = Math.ceil((rawVideoLimit + 16) / 3) * 4
  + "data:application/vnd.yachat.e2ee;base64,".length;

assert.ok(
  encryptedVideoDataUrlLength < clientDataUrlLimit,
  "an 8 MB encrypted video must fit the client transport limit"
);
assert.equal(clientDataUrlLimit, serverDataUrlLimit);
assert.equal(clientDataUrlLimit, e2eeDataUrlLimit);
assert.match(app, /encoded\.dataUrl\.length > ATTACHMENT_DATA_URL_LIMIT_CHARS/);

assert.doesNotMatch(app, /Модератор получит всю переписку/);
assert.doesNotMatch(app, /Название личного чата берётся из профиля собеседника/);
assert.doesNotMatch(app, /A moderator will receive the full conversation/);
assert.doesNotMatch(app, /The private chat name comes from the other person's profile/);

assert.match(groupFlow, /data-group-primary/);
assert.match(groupFlow, /function advanceFlow\(\)/);

const formListeners = new Map();
const modalListeners = new Map();
const bodyClasses = new Set();
const createChatForm = {
  className: "",
  markup: "",
  set innerHTML(value) {
    this.markup = String(value);
  },
  get innerHTML() {
    return this.markup;
  },
  setAttribute() {},
  addEventListener(type, handler) {
    formListeners.set(type, handler);
  },
  querySelector(selector) {
    if (selector === "[data-group-search]" && this.markup.includes("data-group-search")) {
      return { focus() {}, setSelectionRange() {} };
    }
    if (selector === "[data-group-title]" && this.markup.includes("data-group-title")) {
      return { focus() {} };
    }
    if (selector.includes("group-flow-primary") && this.markup.includes("data-group-primary")) {
      return { disabled: false };
    }
    return null;
  }
};
const createChatModal = {
  className: "",
  hidden: true,
  dataset: {},
  addEventListener(type, handler) {
    modalListeners.set(type, handler);
  }
};
const context = {
  createChatModal,
  createChatForm,
  state: {
    language: "ru",
    account: { id: "self" },
    createChatSelectedIds: [],
    pendingCreateChatAvatarDataUrl: "",
    createChatSearchError: "",
    createChatSearchLoading: false,
    createChatSearchRequestId: 0,
    newChatKind: "group",
    chats: [],
    messages: []
  },
  openCreateChat() {},
  closeCreateChat() {},
  renderCreateChatForm() {},
  createChatFromForm() {},
  escapeHtml: (value) => String(value ?? ""),
  cleanDisplayText: (value, fallback = "") => String(value || fallback),
  mergeUsers: (...groups) => {
    const byId = new Map();
    groups.flat().forEach((user) => {
      if (user?.id) byId.set(user.id, user);
    });
    return [...byId.values()];
  },
  normalizeUser: (user) => user,
  historicalChatUsers: () => [],
  renderUserAvatar: () => '<span class="user-avatar"></span>',
  renderVerified: () => "",
  translatedServerMessage: (message) => String(message || ""),
  readAvatarFile: async () => "",
  renderChatList() {},
  renderActiveChat() {},
  renderMessages() {},
  setMobileDialogOpen() {},
  yachatApi: {
    users: {
      search: async () => [{
        id: "person-1",
        displayName: "Лиля",
        username: "lily",
        statusText: "была недавно"
      }]
    },
    messenger: {
      createChat: async () => ({ chat: { id: "group-1" }, chats: [], messages: [] }),
      chats: async () => []
    }
  },
  document: {
    body: {
      classList: {
        add: (...names) => names.forEach((name) => bodyClasses.add(name)),
        remove: (...names) => names.forEach((name) => bodyClasses.delete(name))
      }
    },
    documentElement: {}
  },
  MutationObserver: class {
    observe() {}
  },
  requestAnimationFrame: (callback) => callback(),
  setTimeout,
  clearTimeout,
  Map,
  Set,
  CSS: { escape: (value) => String(value) }
};
context.window = context;

vm.runInNewContext(groupFlow, context, { filename: "group-creation-flow.js" });
context.openCreateChat();
await new Promise((resolve) => setImmediate(resolve));

formListeners.get("click")({
  target: {
    closest(selector) {
      return selector === "[data-group-user]"
        ? { dataset: { groupUser: "person-1" } }
        : null;
    }
  },
  preventDefault() {},
  stopImmediatePropagation() {}
});
formListeners.get("click")({
  target: {
    closest(selector) {
      return selector === "[data-group-primary]" ? { disabled: false } : null;
    }
  },
  preventDefault() {},
  stopImmediatePropagation() {}
});

assert.equal(createChatModal.dataset.groupFlowStep, "details");
assert.match(createChatForm.innerHTML, /data-group-title/);
assert.equal(JSON.stringify(context.state.createChatSelectedIds), '["person-1"]');
console.log("reported regressions passed");

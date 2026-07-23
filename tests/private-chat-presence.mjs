import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const patchPath = path.resolve("src/renderer/assets/private-chat-presence.js");
const accounts = {
  murochko: { id: "murochko", username: "murochko", displayName: "Мурочко" },
  vaagn: { id: "vaagn", username: "vaagn", displayName: "Vaagn", bio: "" }
};
const chatId = "private-console-murochko-vaagn";
const server = {
  messages: [],
  lastRead: {
    murochko: Date.now(),
    vaagn: Date.now()
  }
};

function peerName(username) {
  return username === "murochko" ? "vaagn" : "murochko";
}

function snapshotFor(username, includePrivate = true) {
  const peer = accounts[peerName(username)];
  const own = accounts[username];
  const visibleMessages = server.messages.map((message) => ({
    ...message,
    author: message.authorId === own.id ? "user" : "contact",
    deliveryStatus: message.authorId === own.id
      ? (server.lastRead[peer.username] >= message.createdMs ? "read" : "sent")
      : undefined
  }));
  const unread = visibleMessages.filter((message) => (
    message.author === "contact" && message.createdMs > server.lastRead[username]
  )).length;
  const favorites = {
    id: "yachat-favorites",
    kind: "saved",
    title: "Избранное",
    subtitle: "Сообщения для себя",
    description: "Сообщения для себя",
    participantIds: [own.id],
    pinned: true,
    unread: 0
  };
  const privateChat = {
    id: chatId,
    kind: "private",
    title: peer.displayName,
    subtitle: `@${peer.username}`,
    description: "",
    profileAbout: "",
    participantIds: [own.id, peer.id],
    participantProfiles: {
      [own.id]: own,
      [peer.id]: peer
    },
    unread
  };
  return {
    chats: includePrivate ? [favorites, privateChat] : [favorites],
    activeChatId: includePrivate ? chatId : "yachat-favorites",
    messages: includePrivate ? visibleMessages : [],
    routeUser: peer
  };
}

const harness = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>YaChat console regression</title></head>
<body><main id="surface"></main>
<script>
const SYSTEM_CHAT_IDS = new Set(["yachat-favorites", "yachat-codes", "yachat-channel"]);
const state = {
  account: null,
  chats: [],
  messages: [],
  activeChatId: "yachat-favorites",
  pendingSearchChat: null,
  activePanel: null,
  mobileDialogOpen: true
};
const renderHistory = [];
const yachatApi = {
  messenger: {
    markRead: (payload) => window.serverMarkRead(state.account.username, payload.chatId)
  }
};
function normalizeUsername(value) { return String(value || "").trim().toLowerCase().replace(/^@+/, ""); }
function normalizeUser(user) { return user && user.id ? { ...user } : null; }
function routeUsernameFromLocation() { return normalizeUsername(location.pathname.replace(/^\\/+|\\/+$/g, "")); }
function getPrivateChatParticipantId(chat) {
  if (chat?.kind !== "private") return "";
  return (chat.participantIds || []).map(String).find((id) => id && id !== String(state.account?.id || "")) || "";
}
function createPendingSearchChat(user) {
  return {
    id: "search-user-" + user.id,
    kind: "private",
    title: user.displayName || user.username,
    subtitle: user.username ? "@" + user.username : "Личный чат",
    description: "",
    profileAbout: "",
    participantIds: [state.account?.id, user.id].filter(Boolean),
    participantProfiles: { [user.id]: user },
    pendingSearchUserId: user.id,
    unread: 0
  };
}
function getActiveChat() {
  if (state.pendingSearchChat?.id === state.activeChatId) return state.pendingSearchChat;
  return state.chats.find((chat) => chat.id === state.activeChatId) || state.chats[0] || null;
}
function getChatTitle(chat) { return chat?.id === "yachat-favorites" ? "Избранное" : String(chat?.title || "ЯЧат"); }
function getChatSubtitle(chat) { return chat?.id === "yachat-favorites" ? "Сообщения для себя" : String(chat?.description || chat?.subtitle || "Личный чат"); }
function renderComposerContext() {}
function renderChatList() {}
function renderActiveChat() {
  const chat = getActiveChat();
  renderHistory.push({ title: getChatTitle(chat), subtitle: getChatSubtitle(chat), chatId: chat?.id || "" });
  document.querySelector("#surface").textContent = getChatTitle(chat) + "|" + getChatSubtitle(chat);
}
function renderMessages() {
  window.renderedStatuses = state.messages.map((message) => ({ id: message.id, status: message.deliveryStatus || "" }));
}
function setMobileDialogOpen(value) { state.mobileDialogOpen = Boolean(value); }
function hideErrorPage() {}
function activeChatIsVisible() { return true; }
function messengerPollDelay() { return 1200; }
async function markActiveChatReadIfVisible() {}
async function openRouteUserIfNeeded() { return false; }
function routeNeeds404Check() { return false; }
function chatIdFromRoute() { return ""; }
function showErrorPage() {}
async function applyMessengerSnapshot(snapshot = {}, selectedChatId = state.activeChatId) {
  state.pendingSearchChat = null;
  state.chats = Array.isArray(snapshot.chats) ? snapshot.chats : [];
  const preferred = snapshot.activeChatId || selectedChatId;
  state.activeChatId = state.chats.some((chat) => chat.id === preferred)
    ? preferred
    : state.chats[0]?.id || "yachat-favorites";
  state.messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  renderComposerContext(); renderChatList(); renderActiveChat(); renderMessages();
}
async function refreshMessengerFromServer() {
  const snapshot = await window.serverSnapshot(state.account.username, true);
  await applyMessengerSnapshot(snapshot, state.activeChatId, { followRoute: true });
  await markActiveChatReadIfVisible();
}
function startHarnessPolling() {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    await refreshMessengerFromServer();
    setTimeout(tick, messengerPollDelay());
  };
  setTimeout(tick, 0);
  return () => { stopped = true; };
}
async function sendHarnessMessage(text) {
  const result = await window.serverSend(state.account.username, text);
  await refreshMessengerFromServer();
  return result;
}
</script></body></html>`;

const webServer = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(harness);
});
await new Promise((resolve) => webServer.listen(0, "127.0.0.1", resolve));
const port = webServer.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});
const pageErrors = [];
const consoleErrors = [];
const pages = [];

async function createClient(username) {
  const page = await browser.newPage();
  pages.push(page);
  page.on("pageerror", (error) => pageErrors.push(`${username}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${username}: ${message.text()}`);
  });
  await page.exposeFunction("serverSnapshot", (name, includePrivate = true) => snapshotFor(name, includePrivate));
  await page.exposeFunction("serverMarkRead", (name, requestedChatId) => {
    assert.equal(requestedChatId, chatId);
    server.lastRead[name] = Date.now();
    return snapshotFor(name, true);
  });
  await page.exposeFunction("serverSend", (name, text) => {
    const createdMs = Date.now();
    const message = {
      id: `console-test-${createdMs}-${server.messages.length + 1}`,
      chatId,
      authorId: accounts[name].id,
      text: String(text || ""),
      createdAt: new Date(createdMs).toISOString(),
      createdMs
    };
    server.messages.push(message);
    server.lastRead[name] = createdMs;
    return { id: message.id };
  });
  await page.goto(`http://127.0.0.1:${port}/${peerName(username)}`);
  await page.addScriptTag({ path: patchPath });
  await page.evaluate((account) => { state.account = account; }, accounts[username]);
  return page;
}

try {
  const murochko = await createClient("murochko");

  await murochko.evaluate(async () => {
    renderHistory.length = 0;
    const snapshot = await window.serverSnapshot("murochko", false);
    await applyMessengerSnapshot(snapshot, "yachat-favorites", { followRoute: true });
  });
  const routeState = await murochko.evaluate(() => ({
    activeChatId: state.activeChatId,
    pendingTitle: state.pendingSearchChat?.title || "",
    pendingSubtitle: state.pendingSearchChat?.subtitle || "",
    surface: document.querySelector("#surface")?.textContent || "",
    renderHistory: [...renderHistory],
    patch: document.documentElement.dataset.yachatPrivateChatGuard
  }));
  assert.equal(routeState.patch, "private-route-read-v1");
  assert.equal(routeState.activeChatId, "search-user-vaagn");
  assert.equal(routeState.pendingTitle, "Vaagn");
  assert.equal(routeState.pendingSubtitle, "@vaagn");
  assert.equal(routeState.surface, "Vaagn|@vaagn");
  assert.equal(routeState.renderHistory.some((entry) => entry.title === "Избранное" || entry.subtitle === "Сообщения для себя"), false);

  const vaagn = await createClient("vaagn");
  await Promise.all([
    murochko.evaluate(() => refreshMessengerFromServer()),
    vaagn.evaluate(() => refreshMessengerFromServer())
  ]);
  await murochko.evaluate(() => { window.stopHarnessPolling = startHarnessPolling(); });
  await vaagn.evaluate(() => { window.stopHarnessPolling = startHarnessPolling(); });

  const startedAt = Date.now();
  const sent = await murochko.evaluate(() => sendHarnessMessage("console read receipt test"));
  await murochko.waitForFunction((messageId) => (
    (window.renderedStatuses || []).some((message) => message.id === messageId && message.status === "read")
  ), sent.id, { timeout: 1800 });
  const readLatencyMs = Date.now() - startedAt;
  assert.ok(readLatencyMs < 1800, `read receipt took ${readLatencyMs}ms`);

  const receiverState = await vaagn.evaluate(() => ({
    activeChatId: state.activeChatId,
    unread: Number(getActiveChat()?.unread || 0),
    messages: state.messages.map((message) => message.id)
  }));
  assert.equal(receiverState.activeChatId, chatId);
  assert.equal(receiverState.unread, 0);
  assert.ok(receiverState.messages.includes(sent.id));

  await Promise.all(pages.map((page) => page.evaluate(() => window.stopHarnessPolling?.())));
  const createdIds = server.messages.map((message) => message.id);
  server.messages = server.messages.filter((message) => !createdIds.includes(message.id));
  assert.equal(server.messages.length, 0, "console test messages must be deleted");
  await Promise.all([
    murochko.evaluate(() => refreshMessengerFromServer()),
    vaagn.evaluate(() => refreshMessengerFromServer())
  ]);
  const residue = await Promise.all(pages.map((page) => page.evaluate(() => state.messages.length)));
  assert.deepEqual(residue, [0, 0], "test messages must disappear from both clients");

  assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
  assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join("\n")}`);
  console.log(JSON.stringify({
    ok: true,
    routeChat: routeState.activeChatId,
    forbiddenFavoritesRenders: 0,
    readLatencyMs,
    deletedTestMessages: createdIds.length,
    remainingTestMessages: 0
  }));
} finally {
  await browser.close();
  await new Promise((resolve) => webServer.close(resolve));
}

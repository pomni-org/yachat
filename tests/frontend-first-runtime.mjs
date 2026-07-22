import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const executablePath = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

await page.setContent("<!doctype html><html><body></body></html>");
await page.evaluate(() => {
  globalThis.renderCounts = { list: 0, active: 0, messages: 0, composer: 0 };
  globalThis.fullReloadCalls = 0;
  globalThis.sendResolver = null;
  globalThis.deleteResolver = null;
  globalThis.state = {
    activeChatId: "chat-1",
    chats: [{
      id: "chat-1",
      kind: "private",
      title: "Тест",
      createdAt: "2026-07-23T00:00:00Z",
      updatedAt: "2026-07-23T00:00:00Z",
      lastMessage: "",
      lastAt: null,
      unread: 0
    }],
    messages: [],
    selectedMessageIds: new Set(),
    selectingMessages: false,
    editingMessageId: null,
    replyToMessage: null,
    transientMessagesByChat: new Map()
  };

  globalThis.getActiveChat = () => state.chats[0];
  globalThis.setTransientMessage = (chatId, message) => {
    if (!state.transientMessagesByChat.has(chatId)) state.transientMessagesByChat.set(chatId, new Map());
    state.transientMessagesByChat.get(chatId).set(message.id, message);
  };
  globalThis.removeTransientMessage = (chatId, messageId) => state.transientMessagesByChat.get(chatId)?.delete(messageId);
  globalThis.transientMessagesForChat = (chatId) => [...(state.transientMessagesByChat.get(chatId)?.values() || [])];
  globalThis.renderChatList = () => { renderCounts.list += 1; };
  globalThis.renderActiveChat = () => { renderCounts.active += 1; };
  globalThis.renderMessages = () => { renderCounts.messages += 1; };
  globalThis.renderComposerContext = () => { renderCounts.composer += 1; };
  globalThis.showActionFeedback = () => {};
  globalThis.translatedServerMessage = (message) => message;
  globalThis.deliverTransientMessage = async () => false;
  globalThis.deleteMessages = async () => {};
  globalThis.yachatApi = {
    messenger: {
      send: () => new Promise((resolve) => { sendResolver = resolve; }),
      deleteMessage: () => new Promise((resolve) => { deleteResolver = resolve; }),
      list: async () => { fullReloadCalls += 1; return []; },
      messages: async () => { fullReloadCalls += 1; return []; }
    }
  };
});

await page.addScriptTag({ path: "src/renderer/assets/frontend-first-runtime.js" });

const sendPending = page.evaluate(() => {
  const message = {
    id: "client-1",
    chatId: "chat-1",
    text: "мгновенно",
    formattedHtml: "<strong>мгновенно</strong>",
    attachments: [],
    createdAt: "2026-07-23T00:00:01Z"
  };
  window.__sendPromise = deliverTransientMessage(state.chats[0], message);
});
await sendPending;

const optimistic = await page.evaluate(() => ({
  transient: transientMessagesForChat("chat-1").map((item) => ({ id: item.id, status: item.deliveryStatus })),
  stateMessages: state.messages.length,
  renders: { ...renderCounts },
  fullReloadCalls
}));
assert.deepEqual(optimistic.transient, [{ id: "client-1", status: "sending" }]);
assert.equal(optimistic.stateMessages, 0);
assert.ok(optimistic.renders.messages >= 1);
assert.equal(optimistic.fullReloadCalls, 0);

await page.evaluate(() => sendResolver({
  ok: true,
  message: {
    id: "client-1",
    chatId: "chat-1",
    text: "мгновенно",
    formattedHtml: "<strong>мгновенно</strong>",
    attachments: [],
    createdAt: "2026-07-23T00:00:01Z"
  }
}));
await page.evaluate(() => window.__sendPromise);

const acknowledged = await page.evaluate(() => ({
  transient: transientMessagesForChat("chat-1").length,
  messages: state.messages.map((item) => ({ id: item.id, text: item.text, status: item.deliveryStatus })),
  preview: state.chats[0].lastMessage,
  fullReloadCalls
}));
assert.equal(acknowledged.transient, 0);
assert.deepEqual(acknowledged.messages, [{ id: "client-1", text: "мгновенно", status: "sent" }]);
assert.equal(acknowledged.preview, "мгновенно");
assert.equal(acknowledged.fullReloadCalls, 0);

await page.evaluate(() => {
  state.selectedMessageIds.add("client-1");
  window.__deletePromise = deleteMessages(["client-1"], "everyone");
});

const deletedOptimistically = await page.evaluate(() => ({
  messages: state.messages.length,
  preview: state.chats[0].lastMessage,
  selected: state.selectedMessageIds.has("client-1"),
  fullReloadCalls
}));
assert.equal(deletedOptimistically.messages, 0);
assert.equal(deletedOptimistically.preview, "");
assert.equal(deletedOptimistically.selected, true);
assert.equal(deletedOptimistically.fullReloadCalls, 0);

await page.evaluate(() => deleteResolver({
  ok: true,
  chatId: "chat-1",
  deletedIds: ["client-1"],
  physicallyDeletedIds: ["client-1"],
  scope: "everyone"
}));
await page.evaluate(() => window.__deletePromise);

const deletedAck = await page.evaluate(() => ({
  messages: state.messages.length,
  selected: state.selectedMessageIds.has("client-1"),
  selecting: state.selectingMessages,
  fullReloadCalls
}));
assert.equal(deletedAck.messages, 0);
assert.equal(deletedAck.selected, false);
assert.equal(deletedAck.selecting, false);
assert.equal(deletedAck.fullReloadCalls, 0);

assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join("\n")}`);

await browser.close();
console.log("frontend-first runtime suite passed");

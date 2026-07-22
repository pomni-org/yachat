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

await page.setContent(`<!doctype html>
<html>
  <body>
    <form class="composer" data-form="message">
      <div data-composer-context hidden></div>
      <div data-attachment-tray hidden></div>
      <input data-message-input name="message" placeholder="Сообщение">
      <button class="send-button" type="submit">send</button>
    </form>
    <div data-message-list></div>
  </body>
</html>`);

await page.evaluate(() => {
  const pendingResolvers = [];
  globalThis.pendingResolvers = pendingResolvers;
  globalThis.sentPayloads = [];
  globalThis.renderCounts = { chats: 0, messages: 0, active: 0 };
  globalThis.state = {
    account: { id: "self" },
    activeChatId: "chat-1",
    chats: [{
      id: "chat-1",
      kind: "private",
      title: "Собеседник",
      canSend: true,
      lastMessage: "",
      lastAt: "",
      unread: 0
    }],
    messages: [],
    pendingAttachments: [],
    replyToMessage: null,
    editingMessageId: null,
    pendingSearchChat: null,
    transientMessagesByChat: new Map(),
    selectedMessageIds: new Set(),
    selectingMessages: false
  };

  globalThis.getActiveChat = () => state.chats[0];
  globalThis.canSendToChat = () => true;
  globalThis.renderAttachmentTray = () => {};
  globalThis.renderComposerContext = () => {};
  globalThis.renderChatList = () => { renderCounts.chats += 1; };
  globalThis.renderMessages = () => { renderCounts.messages += 1; };
  globalThis.renderActiveChat = () => { renderCounts.active += 1; };
  globalThis.showActionFeedback = () => {};
  globalThis.translatedServerMessage = (message) => message;
  globalThis.ensureRealChatForMessage = async (chat) => chat;
  globalThis.deleteMessages = async () => {};

  globalThis.setTransientMessage = (chatId, message) => {
    if (!state.transientMessagesByChat.has(chatId)) {
      state.transientMessagesByChat.set(chatId, new Map());
    }
    state.transientMessagesByChat.get(chatId).set(message.id, message);
  };
  globalThis.removeTransientMessage = (chatId, messageId) => {
    state.transientMessagesByChat.get(chatId)?.delete(messageId);
  };
  globalThis.transientMessagesForChat = (chatId) => [
    ...(state.transientMessagesByChat.get(chatId)?.values() || [])
  ];
  globalThis.getMessageById = (messageId) => {
    for (const messages of state.transientMessagesByChat.values()) {
      if (messages.has(messageId)) return messages.get(messageId);
    }
    return state.messages.find((message) => message.id === messageId) || null;
  };
  globalThis.createTransientOutgoingMessage = (chat, payload) => ({
    id: "11111111-1111-4111-8111-111111111111",
    chatId: chat.id,
    senderId: "self",
    createdAt: "2026-07-23T00:00:00Z",
    formattedHtml: "<strong>быстро</strong>",
    ...payload
  });
  globalThis.deliverTransientMessage = async () => false;

  globalThis.yachatApi = {
    messenger: {
      send: (payload) => {
        sentPayloads.push(payload);
        return new Promise((resolve) => pendingResolvers.push(() => resolve({
          ok: true,
          inserted: true,
          message: {
            id: payload.clientMessageId,
            chatId: payload.chatId,
            senderId: "self",
            text: payload.text,
            formattedHtml: payload.formattedHtml || "",
            attachments: payload.attachments || [],
            createdAt: "2026-07-23T00:00:01Z"
          }
        })));
      },
      deleteMessage: async () => ({ ok: true })
    }
  };
});

for (const path of [
  "src/renderer/assets/composer-delivery-stable.js",
  "src/renderer/assets/frontend-first-runtime.js"
]) {
  await page.addScriptTag({ path });
}

await page.evaluate(() => {
  const input = document.querySelector('[data-message-input]');
  input.value = "быстро";
  document.querySelector('[data-form="message"]').requestSubmit();
});

const optimistic = await page.evaluate(() => ({
  input: document.querySelector('[data-message-input]').value,
  transient: transientMessagesForChat("chat-1").map((message) => ({
    id: message.id,
    text: message.text,
    status: message.deliveryStatus
  })),
  persisted: state.messages.length,
  sent: sentPayloads.length,
  chatPreview: state.chats[0].lastMessage
}));

assert.equal(optimistic.input, "", "composer must clear before the network response");
assert.deepEqual(optimistic.transient, [{
  id: "11111111-1111-4111-8111-111111111111",
  text: "быстро",
  status: "sending"
}]);
assert.equal(optimistic.persisted, 0);
assert.equal(optimistic.sent, 0, "network delivery is intentionally queued after optimistic paint");

await page.waitForFunction(() => sentPayloads.length === 1);
const requestPayload = await page.evaluate(() => sentPayloads[0]);
assert.equal(requestPayload.text, "быстро");
assert.equal(requestPayload.formattedHtml, "<strong>быстро</strong>");

await page.evaluate(() => pendingResolvers.shift()?.());
await page.waitForFunction(() => state.messages.length === 1 && transientMessagesForChat("chat-1").length === 0);

const delivered = await page.evaluate(() => ({
  messages: state.messages.map((message) => ({
    id: message.id,
    text: message.text,
    formattedHtml: message.formattedHtml,
    status: message.deliveryStatus
  })),
  transientCount: transientMessagesForChat("chat-1").length,
  chatPreview: state.chats[0].lastMessage,
  chatLastAt: state.chats[0].lastAt,
  renderCounts
}));

assert.deepEqual(delivered.messages, [{
  id: "11111111-1111-4111-8111-111111111111",
  text: "быстро",
  formattedHtml: "<strong>быстро</strong>",
  status: "sent"
}]);
assert.equal(delivered.transientCount, 0);
assert.equal(delivered.chatPreview, "быстро");
assert.equal(delivered.chatLastAt, "2026-07-23T00:00:01Z");
assert.ok(delivered.renderCounts.chats >= 2);
assert.ok(delivered.renderCounts.messages >= 2);

assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join("\n")}`);

await browser.close();
console.log("frontend-first delivery suite passed");

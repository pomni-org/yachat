import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const executablePath = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
      <button type="button" data-action="attach-file">attach</button>
      <div data-rich-message-editor hidden></div>
      <textarea data-native-ios-message-input placeholder="Сообщение"></textarea>
      <input type="hidden" data-message-input name="message" value="">
      <button class="send-button" type="submit" disabled>send</button>
    </form>
    <div data-message-list></div>
  </body>
</html>`);

await page.evaluate(() => {
  const pendingResolvers = [];
  globalThis.pendingResolvers = pendingResolvers;
  globalThis.sentPayloads = [];
  globalThis.eventOrder = [];
  globalThis.renderCounts = { chats: 0, messages: 0, active: 0 };

  const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => nativeRequestAnimationFrame((time) => {
    eventOrder.push("frame");
    callback(time);
  });

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
  globalThis.renderChatList = () => {
    eventOrder.push("render-chats");
    renderCounts.chats += 1;
  };
  globalThis.renderMessages = () => {
    eventOrder.push("render-messages");
    renderCounts.messages += 1;
  };
  globalThis.renderActiveChat = () => {
    eventOrder.push("render-active");
    renderCounts.active += 1;
  };
  globalThis.showActionFeedback = () => {};
  globalThis.translatedServerMessage = (message) => message;
  globalThis.ensureRealChatForMessage = async (chat) => chat;
  globalThis.deleteMessages = async () => {};

  globalThis.setTransientMessage = (chatId, message) => {
    if (!state.transientMessagesByChat.has(chatId)) state.transientMessagesByChat.set(chatId, new Map());
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
        eventOrder.push("network");
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

  const form = document.querySelector('[data-form="message"]');
  const visible = form.querySelector('[data-native-ios-message-input]');
  const transport = form.querySelector('[data-message-input]');
  form.__yachatSyncRichEditor = () => {
    transport.value = visible.value.replace(/\r/g, "");
    return transport.value;
  };
});

for (const path of [
  "src/renderer/assets/composer-delivery-stable.js",
  "src/renderer/assets/composer-actions-stable.js",
  "src/renderer/assets/frontend-first-runtime.js"
]) {
  await page.addScriptTag({ path });
}

await page.evaluate(() => {
  const visible = document.querySelector('[data-native-ios-message-input]');
  const transport = document.querySelector('[data-message-input]');
  const send = document.querySelector('.send-button');
  visible.value = "быстро";
  transport.value = "";
  // Reproduce the stale state left by the old hidden-input listener.
  send.disabled = true;
});

await page.locator('.send-button').click();
await page.waitForFunction(() => sentPayloads.length === 1);

const optimistic = await page.evaluate(() => ({
  visible: document.querySelector('[data-native-ios-message-input]').value,
  transport: document.querySelector('[data-message-input]').value,
  sendDisabled: document.querySelector('.send-button').disabled,
  sendAvailable: document.querySelector('.send-button').dataset.yachatSendAvailable,
  transient: transientMessagesForChat("chat-1").map((message) => ({
    id: message.id,
    text: message.text,
    status: message.deliveryStatus
  })),
  persisted: state.messages.length,
  payloads: sentPayloads.map((payload) => ({ ...payload })),
  eventOrder: [...eventOrder]
}));

assert.equal(optimistic.visible, "", "visible composer must clear on the first tap");
assert.equal(optimistic.transport, "", "hidden transport must clear on the first tap");
assert.equal(optimistic.sendDisabled, false, "ordinary validation must never natively disable the send control");
assert.equal(optimistic.payloads.length, 1, "one tap must create exactly one request");
assert.equal(optimistic.payloads[0].text, "быстро", "the request must read the visible field, not stale transport");
assert.equal(optimistic.payloads[0].formattedHtml, "<strong>быстро</strong>");
assert.deepEqual(optimistic.transient, [{
  id: "11111111-1111-4111-8111-111111111111",
  text: "быстро",
  status: "sending"
}]);
assert.equal(optimistic.persisted, 0);

const firstRender = Math.min(
  ...["render-messages", "render-chats"]
    .map((name) => optimistic.eventOrder.indexOf(name))
    .filter((index) => index >= 0)
);
const firstFrame = optimistic.eventOrder.indexOf("frame");
const firstNetwork = optimistic.eventOrder.indexOf("network");
assert.ok(firstRender >= 0, `optimistic render missing: ${optimistic.eventOrder.join(", ")}`);
assert.ok(firstNetwork > firstRender, `network must start after synchronous optimistic rendering: ${optimistic.eventOrder.join(", ")}`);
assert.ok(firstFrame < 0 || firstNetwork < firstFrame, `network must not wait for requestAnimationFrame: ${optimistic.eventOrder.join(", ")}`);

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
console.log("first-tap frontend delivery suite passed");
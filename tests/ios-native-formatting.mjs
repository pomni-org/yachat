import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const executablePath = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const browser = await chromium.launch({ headless: true, executablePath });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
});
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

await page.setContent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      body { padding-top: 120px; }
      .composer { position: relative; }
    </style>
  </head>
  <body>
    <form class="composer" data-form="message">
      <div data-composer-context hidden></div>
      <p data-attachment-policy hidden></p>
      <div data-attachment-tray hidden></div>
      <button type="button" data-action="attach-file">attach</button>
      <input type="file" data-attachment-input hidden>
      <button type="button" data-action="attach-document">document</button>
      <input type="file" data-document-input hidden>
      <input data-message-input name="message" placeholder="Сообщение">
      <button type="button" data-action="open-stickers">emoji</button>
      <button class="send-button" type="submit" disabled>send</button>
    </form>
    <div data-message-list></div>
  </body>
</html>`);

await page.evaluate(() => {
  globalThis.messageForm = document.querySelector('[data-form="message"]');
  globalThis.messageInput = document.querySelector('[data-message-input]');
  globalThis.sendButton = document.querySelector('.send-button');
  globalThis.state = {
    account: { id: "self" },
    activeChatId: "chat-1",
    chats: [{ id: "chat-1", kind: "private", canSend: true }],
    messages: [],
    pendingAttachments: [],
    editingMessageId: null,
    replyToMessage: null,
    transientMessagesByChat: new Map()
  };
  globalThis.escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  globalThis.getActiveChat = () => state.chats[0];
  globalThis.canSendToChat = () => true;
  globalThis.setTransientMessage = (chatId, message) => {
    if (!state.transientMessagesByChat.has(chatId)) {
      state.transientMessagesByChat.set(chatId, new Map());
    }
    state.transientMessagesByChat.get(chatId).set(message.id, message);
  };
  globalThis.getMessageById = (id) => {
    for (const messages of state.transientMessagesByChat.values()) {
      if (messages.has(id)) return messages.get(id);
    }
    return null;
  };
  globalThis.createTransientOutgoingMessage = (chat, payload) => ({
    id: "client-message-1",
    chatId: chat.id,
    createdAt: new Date().toISOString(),
    ...payload
  });
  globalThis.startEditMessage = () => {};
  globalThis.renderAttachment = () => "";
  globalThis.renderMessages = () => {};
  globalThis.renderAttachmentTray = () => {};
  globalThis.renderActiveChat = () => {};
  globalThis.sentPayloads = [];
  globalThis.promptCalls = 0;
  globalThis.linkClicks = 0;
  globalThis.yachatApi = {
    messenger: {
      send: async (payload) => {
        sentPayloads.push(payload);
        return { ok: true, message: { id: payload.clientMessageId, text: payload.text, formattedHtml: payload.formattedHtml || "" } };
      },
      updateMessage: async (payload) => payload
    }
  };
  globalThis.window.yachatFeedback = { show: () => {} };
});

for (const path of [
  "src/renderer/assets/rich-composer-stable.js",
  "src/renderer/assets/ios-native-textarea.js",
  "src/renderer/assets/ios-native-formatting.js",
  "src/renderer/assets/ios-format-selection-guard.js"
]) {
  await page.addScriptTag({ path });
}

await page.waitForSelector('[data-native-ios-message-input]');
const textarea = page.locator('[data-native-ios-message-input]');
await textarea.focus();

let prefix = "";
for (const character of [..."привет мир"]) {
  prefix += character;
  await page.keyboard.insertText(character);
  assert.equal(await textarea.inputValue(), prefix, `text was lost after ${character}`);
}

await page.evaluate(() => {
  const field = document.querySelector('[data-native-ios-message-input]');
  field.focus();
  field.setSelectionRange(0, 6);
  field.dispatchEvent(new Event("select", { bubbles: true }));
});
await page.click('[data-ios-format="bold"]');
let html = await page.evaluate(() => document.querySelector('[data-form="message"]').__yachatGetNativeFormattedHtml());
assert.equal(html, "<strong>привет</strong> мир");

await page.evaluate(() => {
  const field = document.querySelector('[data-native-ios-message-input]');
  field.focus();
  field.setSelectionRange(7, 7);
});
await page.keyboard.insertText("очень ");
assert.equal(await textarea.inputValue(), "привет очень мир");
html = await page.evaluate(() => document.querySelector('[data-form="message"]').__yachatGetNativeFormattedHtml());
assert.equal(html, "<strong>привет</strong> очень мир");

const linkStateBefore = await page.evaluate(() => {
  window.prompt = () => {
    promptCalls += 1;
    return "example.com/path";
  };
  const button = document.querySelector('[data-ios-format="link"]');
  button.addEventListener("click", () => { linkClicks += 1; }, { once: true });
  const field = document.querySelector('[data-native-ios-message-input]');
  field.focus();
  field.setSelectionRange(13, 16);
  field.dispatchEvent(new Event("select", { bubbles: true }));
  return document.querySelector('[data-form="message"]').__yachatGetNativeFormattingState();
});
await page.click('[data-ios-format="link"]');
const linkDiagnostic = await page.evaluate(() => ({
  before: globalThis.linkStateBefore || null,
  after: document.querySelector('[data-form="message"]').__yachatGetNativeFormattingState(),
  promptCalls,
  linkClicks,
  html: document.querySelector('[data-form="message"]').__yachatGetNativeFormattedHtml()
}));
linkDiagnostic.before = linkStateBefore;
html = linkDiagnostic.html;
assert.match(
  html,
  /<a href="https:\/\/example\.com\/path"[^>]*>мир<\/a>/,
  `link formatting diagnostic: ${JSON.stringify(linkDiagnostic)}`
);

const transient = await page.evaluate(() => {
  const message = createTransientOutgoingMessage(getActiveChat(), {
    text: document.querySelector('[data-native-ios-message-input]').value,
    attachments: []
  });
  setTransientMessage(message.chatId, message);
  return message;
});
assert.match(transient.formattedHtml, /<strong>привет<\/strong>/);
assert.match(transient.formattedHtml, /<a href="https:\/\/example\.com\/path"/);

await page.evaluate(async () => {
  await yachatApi.messenger.send({
    chatId: "chat-1",
    clientMessageId: "client-message-1",
    text: getMessageById("client-message-1").text
  });
});
const payload = await page.evaluate(() => sentPayloads.at(-1));
assert.match(payload.formattedHtml, /<strong>привет<\/strong>/);
assert.match(payload.formattedHtml, /<a href="https:\/\/example\.com\/path"/);

assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join("\n")}`);

await browser.close();
console.log("native iOS formatting suite passed");

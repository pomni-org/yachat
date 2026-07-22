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
  <head><meta charset="utf-8"></head>
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

await page.addStyleTag({ path: "src/renderer/assets/rich-composer.css" });
await page.addStyleTag({ path: "src/renderer/assets/message-mentions.css" });
await page.addStyleTag({ path: "src/renderer/assets/composer-regression-fix.css" });

await page.evaluate(() => {
  globalThis.messageForm = document.querySelector('[data-form="message"]');
  globalThis.messageInput = document.querySelector('[data-message-input]');
  globalThis.sendButton = document.querySelector('.send-button');
  globalThis.attachmentTray = document.querySelector('[data-attachment-tray]');
  globalThis.attachmentPolicy = document.querySelector('[data-attachment-policy]');
  globalThis.attachmentInput = document.querySelector('[data-attachment-input]');
  globalThis.documentInput = document.querySelector('[data-document-input]');
  globalThis.documentButton = document.querySelector('[data-action="attach-document"]');
  globalThis.stickersButton = document.querySelector('[data-action="open-stickers"]');
  globalThis.PHOTO_RULE_LIMIT_BYTES = 20 * 1024 * 1024 * 1024;
  globalThis.DOCUMENT_TRANSPORT_LIMIT_BYTES = 8 * 1024 * 1024;
  globalThis.sentPayloads = [];
  globalThis.state = {
    account: { id: "self" },
    activeChatId: "chat-1",
    chats: [{
      id: "chat-1",
      participantIds: ["murochko"],
      participantProfiles: {
        murochko: { id: "murochko", username: "murochko", displayName: "Мурочко" }
      }
    }],
    messages: [],
    pendingAttachments: [],
    editingMessageId: null,
    replyToMessage: null,
    contactMatches: [{ id: "murochko", username: "murochko", displayName: "Мурочко" }],
    chatSearchUsers: [],
    createChatUsers: [],
    mobileDialogOpen: true,
    transientMessagesByChat: new Map()
  };
  globalThis.escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  globalThis.iconSvg = (name) => `<svg data-icon="${name}"></svg>`;
  globalThis.t = (key) => key;
  globalThis.getActiveChat = () => state.chats[0];
  globalThis.canSendToChat = () => true;
  globalThis.renderAttachmentTray = () => {};
  globalThis.renderComposerContext = () => {};
  globalThis.renderChatList = () => {};
  globalThis.renderActiveChat = () => {};
  globalThis.renderMessages = () => {};
  globalThis.renderAttachment = () => "";
  globalThis.historicalChatUsers = () => state.contactMatches;
  globalThis.setTransientMessage = (chatId, message) => {
    if (!state.transientMessagesByChat.has(chatId)) state.transientMessagesByChat.set(chatId, new Map());
    state.transientMessagesByChat.get(chatId).set(message.id, message);
  };
  globalThis.removeTransientMessage = (chatId, messageId) => state.transientMessagesByChat.get(chatId)?.delete(messageId);
  globalThis.transientMessagesForChat = (chatId) => [...(state.transientMessagesByChat.get(chatId)?.values() || [])];
  globalThis.getMessageById = (id) => {
    for (const messages of state.transientMessagesByChat.values()) {
      if (messages.has(id)) return messages.get(id);
    }
    return null;
  };
  globalThis.createTransientOutgoingMessage = (chat, payload) => ({
    id: `local-${Date.now()}`,
    chatId: chat.id,
    createdAt: new Date().toISOString(),
    ...payload
  });
  globalThis.ensureRealChatForMessage = async (chat) => chat;
  globalThis.deliverTransientMessage = async (_chat, message) => {
    sentPayloads.push({ text: message.text, attachments: message.attachments });
    return true;
  };
  globalThis.showActionFeedback = () => {};
  globalThis.translatedServerMessage = (message) => message;
  globalThis.addAttachments = () => Promise.resolve([]);
  globalThis.readFileAsDataUrl = async () => "data:application/octet-stream;base64,";
  globalThis.loadImageElement = async () => ({ naturalWidth: 1, naturalHeight: 1 });
  globalThis.attachmentTypeLabel = () => "file";
  globalThis.yachatApi = {
    messenger: {
      send: async (payload) => payload,
      updateMessage: async (payload) => payload
    },
    users: {
      list: async () => state.contactMatches,
      search: async () => state.contactMatches
    }
  };
});

for (const path of [
  "src/renderer/assets/rich-composer-stable.js",
  "src/renderer/assets/ios-native-textarea.js",
  "src/renderer/assets/ios-native-mentions.js",
  "src/renderer/assets/message-mentions.js",
  "src/renderer/assets/media-emoji-upgrade.js",
  "src/renderer/assets/composer-delivery-stable.js",
  "src/renderer/assets/composer-actions-stable.js",
  "src/renderer/assets/mobile-chat-stable.js"
]) {
  await page.addScriptTag({ path });
}

await page.waitForSelector('[data-native-ios-message-input]');

const snapshot = () => page.evaluate(() => {
  const textarea = document.querySelector('[data-native-ios-message-input]');
  const transport = document.querySelector('[data-message-input]');
  const legacy = document.querySelector('.message-editor');
  const emoji = document.querySelector('[data-action="open-stickers"]');
  return {
    value: textarea.value,
    transport: transport.value,
    start: textarea.selectionStart,
    end: textarea.selectionEnd,
    active: document.activeElement === textarea,
    textareaDisplay: getComputedStyle(textarea).display,
    legacyDisplay: getComputedStyle(legacy).display,
    legacyHasEditorAttribute: legacy.hasAttribute('data-rich-message-editor'),
    emojiDisplay: getComputedStyle(emoji).display,
    emojiDisabled: emoji.disabled
  };
});

async function reset() {
  await page.evaluate(() => {
    const textarea = document.querySelector('[data-native-ios-message-input]');
    textarea.value = "";
    textarea.focus();
    textarea.setSelectionRange(0, 0);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
  });
  await page.waitForTimeout(20);
}

function pass(name) {
  console.log(`[pass] ${name}`);
}

{
  const current = await snapshot();
  assert.equal(current.textareaDisplay, "block");
  assert.equal(current.legacyDisplay, "none");
  assert.equal(current.legacyHasEditorAttribute, false);
  assert.equal(current.emojiDisplay, "none");
  assert.equal(current.emojiDisabled, true);
}
pass("iOS uses a native textarea and detaches the contenteditable editor");

await reset();
let prefix = "";
for (const character of [..."привет"]) {
  prefix += character;
  await page.keyboard.insertText(character);
  await page.waitForTimeout(15);
  const current = await snapshot();
  assert.equal(current.value, prefix, `textarea lost text after ${character}`);
  assert.equal(current.transport, prefix, `transport lost text after ${character}`);
  assert.equal(current.start, prefix.length, `caret jumped after ${character}`);
  assert.equal(current.end, prefix.length, `selection changed after ${character}`);
  assert.equal(current.active, true, `textarea lost focus after ${character}`);
}
pass("sequential typing survives beyond the first symbol");

await reset();
await page.keyboard.insertText("приветмир");
await page.keyboard.press("ArrowLeft");
await page.keyboard.press("ArrowLeft");
await page.keyboard.press("ArrowLeft");
await page.keyboard.insertText(" ");
await page.waitForTimeout(20);
{
  const current = await snapshot();
  assert.equal(current.value, "привет мир");
  assert.equal(current.transport, "привет мир");
  assert.equal(current.start, 7);
}
pass("middle insertion keeps the native caret");

await reset();
await page.keyboard.insertText("раз");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.insertText("два");
await page.waitForTimeout(20);
{
  const current = await snapshot();
  assert.equal(current.value, "раз\n\n\nдва");
  assert.equal(current.transport, "раз\n\n\nдва");
}
pass("repeated Enter is handled natively");

await reset();
await page.keyboard.insertText("привет @mur");
await page.waitForSelector('.message-mention-strip:not([hidden]) [data-ios-mention-user]');
await page.click('[data-ios-mention-user="murochko"]');
await page.waitForTimeout(20);
{
  const current = await snapshot();
  assert.equal(current.value, "привет @murochko ");
  assert.equal(current.transport, "привет @murochko ");
  assert.equal(current.active, true);
}
pass("contact mention insertion uses textarea selectionStart and selectionEnd");

await reset();
await page.keyboard.insertText("сообщение из textarea");
await page.click('.send-button');
await page.waitForTimeout(80);
{
  const result = await page.evaluate(() => ({
    sent: sentPayloads.map((item) => item.text),
    value: document.querySelector('[data-native-ios-message-input]').value,
    transport: document.querySelector('[data-message-input]').value
  }));
  assert.deepEqual(result.sent, ["сообщение из textarea"]);
  assert.equal(result.value, "");
  assert.equal(result.transport, "");
}
pass("send uses the native textarea value and clears the composer");

assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join("\n")}`);
pass("browser console remains clean");

await browser.close();
console.log("native iOS textarea composer suite passed");

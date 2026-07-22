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
const consoleErrors = [];
const pageErrors = [];

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));

await page.setContent(`<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body>
    <form class="composer" data-form="message">
      <div class="composer-context" data-composer-context hidden></div>
      <p data-attachment-policy hidden></p>
      <div data-attachment-tray hidden></div>
      <button class="composer-tool" type="button" data-action="attach-file">attach</button>
      <input type="file" data-attachment-input hidden>
      <button class="composer-tool" type="button" data-action="attach-document">document</button>
      <input type="file" data-document-input hidden>
      <input data-message-input name="message" placeholder="Сообщение">
      <button class="composer-tool" type="button" data-action="open-stickers">emoji</button>
      <button class="send-button" type="submit" disabled>send</button>
    </form>
    <div data-message-list></div>
  </body>
</html>`);

await page.addStyleTag({ path: "src/renderer/assets/rich-composer.css" });
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
  globalThis.state = {
    account: { id: "self" },
    activeChatId: "chat-1",
    chats: [{ id: "chat-1", participantIds: [] }],
    messages: [],
    pendingAttachments: [],
    editingMessageId: null,
    replyToMessage: null,
    contactMatches: [],
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
  globalThis.historicalChatUsers = () => [];
  globalThis.setTransientMessage = () => {};
  globalThis.removeTransientMessage = () => {};
  globalThis.transientMessagesForChat = () => [];
  globalThis.getMessageById = () => null;
  globalThis.createTransientOutgoingMessage = (_chat, payload) => ({ id: "local-1", ...payload });
  globalThis.ensureRealChatForMessage = async (chat) => chat;
  globalThis.deliverTransientMessage = async () => true;
  globalThis.showActionFeedback = () => {};
  globalThis.translatedServerMessage = (message) => message;
  globalThis.readFileAsDataUrl = async () => "data:application/octet-stream;base64,";
  globalThis.loadImageElement = async () => ({ naturalWidth: 1, naturalHeight: 1 });
  globalThis.attachmentTypeLabel = () => "file";
  globalThis.yachatApi = {
    messenger: {
      send: async (payload) => payload,
      updateMessage: async (payload) => payload
    },
    users: {
      list: async () => [],
      search: async () => []
    }
  };
});

for (const path of [
  "src/renderer/assets/rich-composer-stable.js",
  "src/renderer/assets/message-mentions.js",
  "src/renderer/assets/media-emoji-upgrade.js",
  "src/renderer/assets/composer-delivery-stable.js",
  "src/renderer/assets/composer-actions-stable.js",
  "src/renderer/assets/mobile-chat-stable.js"
]) {
  await page.addScriptTag({ path });
}

await page.waitForSelector('[data-rich-message-editor]');

// Reproduce an iOS-style selection loss in the same input turn. The guard is
// registered after this listener, so it must repair a fault caused by an older
// composer/emoji handler rather than merely observing a healthy editor.
await page.evaluate(() => {
  const editor = document.querySelector('[data-rich-message-editor]');
  let first = true;
  editor.addEventListener("input", () => {
    if (!first) return;
    first = false;
    const sink = document.createElement("button");
    sink.type = "button";
    sink.textContent = "focus sink";
    document.body.append(sink);
    sink.focus();
    getSelection()?.removeAllRanges();
  }, true);
});

await page.addScriptTag({ path: "src/renderer/assets/ios-composer-caret-guard.js" });

const snapshot = () => page.evaluate(() => {
  const editor = document.querySelector('[data-rich-message-editor]');
  const transport = document.querySelector('[data-message-input]');
  const emoji = document.querySelector('[data-action="open-stickers"]');
  const selection = getSelection();
  let caret = -1;
  let inside = false;
  if (selection && selection.rangeCount) {
    const range = selection.getRangeAt(0);
    inside = editor.contains(range.startContainer) && editor.contains(range.endContainer);
    if (inside) {
      const prefix = document.createRange();
      prefix.selectNodeContents(editor);
      prefix.setEnd(range.endContainer, range.endOffset);
      caret = prefix.toString().replace(/\r/g, "").length;
    }
  }
  return {
    value: transport.value,
    text: String(editor.innerText || editor.textContent || "").replace(/\r/g, ""),
    caret,
    inside,
    active: document.activeElement === editor,
    connected: editor.isConnected,
    emojiDisplay: getComputedStyle(emoji).display,
    emojiDisabled: emoji.disabled,
    nativeEmojiClass: document.querySelector('[data-form="message"]').classList.contains("is-ios-native-emoji-only")
  };
});

async function resetEditor() {
  await page.evaluate(() => {
    const editor = document.querySelector('[data-rich-message-editor]');
    const transport = document.querySelector('[data-message-input]');
    editor.replaceChildren();
    transport.value = "";
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "deleteContentBackward",
      data: null
    }));
  });
  await page.waitForTimeout(30);
}

function pass(name) {
  console.log(`[pass] ${name}`);
}

{
  const current = await snapshot();
  assert.equal(current.emojiDisplay, "none", "custom emoji button still overlaps the iOS editor");
  assert.equal(current.emojiDisabled, true, "custom emoji button remains focusable on iOS");
  assert.equal(current.nativeEmojiClass, true, "iOS emoji isolation class is missing");
}
pass("custom emoji picker is removed from the iOS editor hit area");

await resetEditor();
let prefix = "";
for (const character of [..."привет"]) {
  prefix += character;
  await page.keyboard.insertText(character);
  await page.waitForTimeout(25);
  const current = await snapshot();
  assert.equal(current.value, prefix, `transport lost text after inserting ${character}`);
  assert.equal(current.text, prefix, `editor lost text after inserting ${character}`);
  assert.equal(current.caret, prefix.length, `caret jumped after inserting ${character}`);
  assert.equal(current.inside, true, `selection left the editor after inserting ${character}`);
  assert.equal(current.active, true, `editor lost focus after inserting ${character}`);
  assert.equal(current.connected, true, `editor was replaced after inserting ${character}`);
}
pass("first-character focus loss is repaired and following characters survive");

await resetEditor();
await page.keyboard.insertText("приветмир");
await page.keyboard.press("ArrowLeft");
await page.keyboard.press("ArrowLeft");
await page.keyboard.press("ArrowLeft");
await page.keyboard.insertText(" ");
await page.waitForTimeout(30);
{
  const current = await snapshot();
  assert.equal(current.value, "привет мир");
  assert.equal(current.caret, 7, "caret moved away from the middle insertion point");
  assert.equal(current.active, true);
}
pass("middle insertion keeps the logical caret");

await resetEditor();
await page.keyboard.insertText("раз");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.insertText("два");
await page.waitForTimeout(30);
{
  const current = await snapshot();
  const newlineCount = (current.value.match(/\n/g) || []).length;
  assert.equal(current.value.startsWith("раз"), true);
  assert.equal(current.value.endsWith("два"), true);
  assert.equal(newlineCount >= 3, true, `only ${newlineCount} line breaks survived`);
  assert.equal(current.active, true);
  assert.equal(current.inside, true);
}
pass("repeated Enter survives with the emoji module loaded");

await resetEditor();
await page.evaluate(() => {
  const editor = document.querySelector('[data-rich-message-editor]');
  editor.focus();
  editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
  editor.textContent = "я";
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertCompositionText",
    data: "я",
    isComposing: true
  }));
  editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "я" }));
});
await page.keyboard.insertText("ч");
await page.waitForTimeout(30);
{
  const current = await snapshot();
  assert.equal(current.value, "яч");
  assert.equal(current.caret, 2);
  assert.equal(current.active, true);
}
pass("composition input keeps the next character");

assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join("\n")}`);
pass("runtime produced no browser-console errors");

await browser.close();
console.log("composer emoji iOS regression suite passed");

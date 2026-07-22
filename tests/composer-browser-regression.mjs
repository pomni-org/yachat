import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const consoleErrors = [];
const pageErrors = [];

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));

await page.setContent(`<!doctype html>
<html>
  <body>
    <form data-form="message">
      <button type="button" data-action="attach-file">attach</button>
      <input data-message-input name="message" placeholder="Сообщение" />
      <button type="button" data-action="open-stickers">stickers</button>
      <button class="send-button" type="submit">send</button>
    </form>
    <div data-message-list></div>
  </body>
</html>`);

await page.evaluate(() => {
  globalThis.messageForm = document.querySelector('[data-form="message"]');
  globalThis.messageInput = document.querySelector('[data-message-input]');
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
  globalThis.getActiveChat = () => state.chats[0];
  globalThis.canSendToChat = () => true;
  globalThis.renderAttachmentTray = () => {};
  globalThis.renderComposerContext = () => {};
  globalThis.renderChatList = () => {};
  globalThis.renderActiveChat = () => {};
  globalThis.renderMessages = () => {};
  globalThis.renderAttachment = () => "";
  globalThis.renderAttachmentTray = () => {};
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
  "src/renderer/assets/composer-delivery-stable.js",
  "src/renderer/assets/composer-actions-stable.js",
  "src/renderer/assets/mobile-chat-stable.js"
]) {
  await page.addScriptTag({ path });
}

await page.waitForSelector('[data-rich-message-editor]');

const snapshot = () => page.evaluate(() => {
  const editor = document.querySelector('[data-rich-message-editor]');
  const transport = document.querySelector('[data-message-input]');
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
      caret = prefix.toString().length;
    }
  }
  return {
    value: transport.value,
    html: editor.innerHTML,
    caret,
    inside,
    active: document.activeElement === editor,
    connected: editor.isConnected
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
  await page.waitForTimeout(20);
}

function pass(name) {
  console.log(`[pass] ${name}`);
}

await resetEditor();
let prefix = "";
for (const character of [..."привет"]) {
  prefix += character;
  await page.keyboard.insertText(character);
  await page.waitForTimeout(15);
  const current = await snapshot();
  assert.equal(current.value, prefix, `transport lost text after inserting ${character}`);
  assert.equal(current.caret, prefix.length, `caret jumped after inserting ${character}`);
  assert.equal(current.inside, true, `selection left the editor after inserting ${character}`);
  assert.equal(current.active, true, `editor lost focus after inserting ${character}`);
  assert.equal(current.connected, true, `editor was replaced after inserting ${character}`);
}
pass("sequential characters do not collapse to one symbol");

await resetEditor();
await page.keyboard.insertText("приветмир");
await page.keyboard.press("ArrowLeft");
await page.keyboard.press("ArrowLeft");
await page.keyboard.press("ArrowLeft");
await page.keyboard.insertText(" ");
await page.waitForTimeout(20);
{
  const current = await snapshot();
  assert.equal(current.value, "привет мир");
  assert.equal(current.caret, 7, "caret moved to the beginning during middle insertion");
  assert.equal(current.active, true);
}
pass("middle insertion preserves the caret");

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
  assert.equal(current.active, true, "editor lost focus after repeated Enter");
  assert.equal(current.inside, true, "caret left the editor after repeated Enter");
  assert.equal(current.caret > 0, true, "caret jumped to the beginning after repeated Enter");
}
pass("repeated Enter creates consecutive line breaks");

await resetEditor();
{
  const prevented = await page.evaluate(() => {
    const editor = document.querySelector('[data-rich-message-editor]');
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true
    });
    editor.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(prevented, false, "plain Enter was prevented instead of being left to the browser");
}
pass("plain Enter remains native and uncancelled");

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
await page.waitForTimeout(20);
{
  const current = await snapshot();
  assert.equal(current.value, "яч");
  assert.equal(current.caret, 2, "caret jumped after composition input");
  assert.equal(current.active, true);
}
pass("composition input keeps following characters and caret");

await resetEditor();
await page.evaluate(() => {
  const editor = document.querySelector('[data-rich-message-editor]');
  const clipboard = new DataTransfer();
  clipboard.setData("text/plain", "строка 1\nстрока 2");
  editor.dispatchEvent(new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: clipboard
  }));
});
await page.waitForTimeout(20);
{
  const current = await snapshot();
  assert.equal(current.value.includes("строка 1"), true);
  assert.equal(current.value.includes("строка 2"), true);
  assert.equal(current.value.includes("\n"), true, "multiline paste lost its line break");
  assert.equal(current.caret > 0, true);
}
pass("multiline paste preserves text and caret");

assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join("\n")}`);
pass("runtime produced no browser errors");

await browser.close();
console.log("composer browser regression suite passed");

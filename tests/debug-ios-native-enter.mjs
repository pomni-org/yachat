import { chromium } from "playwright-core";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome"
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
});
const page = await context.newPage();

await page.setContent(`<!doctype html><html><body>
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
</body></html>`);

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
    account: { id: "self" }, activeChatId: "chat-1",
    chats: [{ id: "chat-1", participantIds: [] }], messages: [],
    pendingAttachments: [], editingMessageId: null, replyToMessage: null,
    contactMatches: [], chatSearchUsers: [], createChatUsers: [],
    mobileDialogOpen: true, transientMessagesByChat: new Map()
  };
  globalThis.escapeHtml = (value) => String(value ?? "");
  globalThis.iconSvg = () => "";
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
  globalThis.createTransientOutgoingMessage = (_chat, payload) => ({ id: "local", ...payload });
  globalThis.ensureRealChatForMessage = async (chat) => chat;
  globalThis.deliverTransientMessage = async () => true;
  globalThis.showActionFeedback = () => {};
  globalThis.translatedServerMessage = (message) => message;
  globalThis.readFileAsDataUrl = async () => "";
  globalThis.loadImageElement = async () => ({ naturalWidth: 1, naturalHeight: 1 });
  globalThis.attachmentTypeLabel = () => "file";
  globalThis.yachatApi = {
    messenger: { send: async (payload) => payload, updateMessage: async (payload) => payload },
    users: { list: async () => [], search: async () => [] }
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
]) await page.addScriptTag({ path });

await page.waitForSelector('[data-native-ios-message-input]');
await page.evaluate(() => {
  const textarea = document.querySelector('[data-native-ios-message-input]');
  window.__enterTrace = [];
  const record = (phase, event) => window.__enterTrace.push({
    phase,
    type: event.type,
    key: event.key || "",
    inputType: event.inputType || "",
    composing: Boolean(event.isComposing),
    prevented: event.defaultPrevented,
    value: textarea.value,
    start: textarea.selectionStart,
    end: textarea.selectionEnd,
    active: document.activeElement === textarea,
    mentionOpen: Boolean(document.querySelector('.message-mention-strip:not([hidden])'))
  });
  for (const type of ["keydown", "beforeinput", "input", "keyup"]) {
    textarea.addEventListener(type, (event) => record("capture", event), true);
    textarea.addEventListener(type, (event) => record("bubble", event), false);
  }
});

const textarea = page.locator('[data-native-ios-message-input]');
await textarea.focus();
await page.keyboard.insertText("раз");
await page.keyboard.press("Enter");
await page.waitForTimeout(80);

console.log(JSON.stringify(await page.evaluate(() => ({
  value: document.querySelector('[data-native-ios-message-input]').value,
  transport: document.querySelector('[data-message-input]').value,
  trace: window.__enterTrace
})), null, 2));

await browser.close();

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(root, "src/renderer/assets/interaction-stable.js"),
  "utf8"
);
const clickHandlers = [];
const calls = { click: 0, showPicker: 0 };
const style = { setProperty() {} };
const mediaInput = {
  accept: "image/*",
  disabled: false,
  value: "old",
  style,
  matches: (selector) => selector === "[data-attachment-input]",
  removeAttribute(name) {
    if (name === "capture") this.capture = undefined;
  },
  click() {
    calls.click += 1;
  },
  showPicker() {
    calls.showPicker += 1;
  }
};
const documentInput = {
  disabled: false,
  value: "",
  style,
  matches: () => false,
  click() {},
  showPicker() {}
};
const attachButton = {
  matches: (selector) => selector.includes('data-action="attach-file"')
};
const document = {
  body: {},
  head: { append() {} },
  querySelector(selector) {
    if (selector === "[data-attachment-input]") return mediaInput;
    if (selector === "[data-document-input]") return documentInput;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === "[data-attachment-input], [data-document-input]") {
      return [mediaInput, documentInput];
    }
    return [];
  },
  createElement() {
    return { dataset: {}, style: {}, textContent: "" };
  },
  addEventListener(type, handler) {
    if (type === "click") clickHandlers.push(handler);
  }
};
const context = {
  document,
  navigator: {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    maxTouchPoints: 5
  },
  window: {
    get __yachatInteractionStableInstalled() {
      return this._installed;
    },
    set __yachatInteractionStableInstalled(value) {
      this._installed = value;
    }
  },
  MutationObserver: class {
    observe() {}
  },
  Element: class {},
  queueMicrotask,
  requestAnimationFrame() {}
};
context.window.window = context.window;
context.window.document = document;
context.window.navigator = context.navigator;
context.window.MutationObserver = context.MutationObserver;
context.window.Element = context.Element;
context.getActiveChat = () => ({ id: "chat-1" });
context.canSendToChat = () => true;
context.window.getActiveChat = context.getActiveChat;
context.window.canSendToChat = context.canSendToChat;

vm.runInNewContext(source, context, { filename: "interaction-stable.js" });

const event = {
  target: {
    closest(selector) {
      return selector.includes('data-action="attach-file"') ? attachButton : null;
    }
  },
  preventDefault() {},
  stopImmediatePropagation() {}
};
clickHandlers.forEach((handler) => handler(event));

assert.match(mediaInput.accept, /image\/\*/);
assert.match(mediaInput.accept, /video\/\*/);
assert.match(mediaInput.accept, /\.mov/);
assert.match(mediaInput.accept, /\.mp4/);
assert.equal(calls.showPicker, 0);
assert.equal(calls.click, 1);

console.log("ios media picker regression passed");

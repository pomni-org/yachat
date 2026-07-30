import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [source, shell] = await Promise.all([
  readFile(
    new URL("../src/renderer/assets/message-preview.js", import.meta.url),
    "utf8"
  ),
  readFile(new URL("../src/renderer/index.html", import.meta.url), "utf8")
]);
assert.ok(
  shell.indexOf("./assets/message-preview.js") < shell.indexOf("./app.js"),
  "the shared preview classifier must load before the Electron app"
);
const context = {
  Array,
  Intl,
  Object,
  Set,
  String
};
context.window = context;
vm.runInNewContext(source, context, { filename: "message-preview.js" });

const preview = context.yachatMessagePreview;
assert.ok(preview);
assert.equal(preview.text({ text: "обычный текст" }), "обычный текст");
assert.equal(preview.text({ text: "😀" }), "😀 Эмодзи");
assert.equal(preview.text({ text: "❤️" }), "😀 Эмодзи");
assert.equal(preview.text({ text: "👨‍👩‍👧‍👦" }), "😀 Эмодзи");
assert.equal(preview.text({ text: "🇷🇺" }), "😀 Эмодзи");
assert.equal(preview.text({ text: "1️⃣" }), "😀 Эмодзи");
assert.equal(preview.text({ text: "😀😀" }), "😀😀");
assert.equal(preview.text({ text: "привет 😀" }), "привет 😀");
assert.equal(
  preview.text({ text: "подпись", attachments: [{ kind: "image" }] }),
  "📷 Фото"
);
assert.equal(
  preview.text({ attachments: [{ kind: "video" }, { mime: "video/mp4" }] }),
  "📹 Видео"
);
assert.equal(
  preview.text({ attachments: [{ kind: "image" }, { kind: "video" }] }),
  "🗂️ Вложения"
);
assert.equal(
  preview.text({ attachments: [{ kind: "file" }] }),
  "🗂️ Вложения"
);

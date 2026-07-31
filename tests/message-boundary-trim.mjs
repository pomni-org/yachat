import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [runtime, delivery, migration] = await Promise.all([
  readFile(
    new URL("../src/renderer/assets/mobile-input-focus.js", import.meta.url),
    "utf8"
  ),
  readFile(
    new URL("../src/renderer/assets/composer-delivery-stable.js", import.meta.url),
    "utf8"
  ),
  readFile(
    new URL(
      "../supabase/migrations/20260731152600_trim_message_boundary_breaks.sql",
      import.meta.url
    ),
    "utf8"
  )
]);

const normalizerSource = runtime.match(
  /const LEADING_BOUNDARY_BREAKS =[\s\S]*?function normalizeMessageBoundaryBreaks\(value\) \{[\s\S]*?\n  \}/
)?.[0];
assert.ok(normalizerSource, "message boundary normalizer must exist");
const normalize = vm.runInNewContext(
  `(() => { ${normalizerSource}; return normalizeMessageBoundaryBreaks; })()`
);

const cases = [
  ["\nпривет\n", "привет"],
  ["\r\n\r\nпривет\r\n", "привет"],
  [" \t\nпривет\n\t ", "привет"],
  ["привет\nмир", "привет\nмир"],
  ["привет\n\nмир", "привет\n\nмир"],
  ["\n  привет\n  мир\n", "  привет\n  мир"],
  ["привет", "привет"],
  ["   ", ""]
];
for (const [source, expected] of cases) {
  assert.equal(normalize(source), expected, JSON.stringify(source));
}

assert.match(runtime, /document\.addEventListener\("submit",[\s\S]*\}, true\);/);
assert.match(runtime, /\[data-form="message"\]/);
assert.match(runtime, /\[data-message-input\]/);
assert.doesNotMatch(runtime, /addEventListener\("input"[\s\S]{0,300}normalizeMessageBoundaryBreaks/);

const syncIndex = delivery.indexOf("form.__yachatSyncRichEditor?.({ dispatch: false })");
const normalizeIndex = delivery.indexOf("const text = normalizeMessageBoundaryBreaks(transport.value)");
const editIndex = delivery.indexOf("if (state.editingMessageId) return;", normalizeIndex);
assert.ok(syncIndex >= 0, "composer must sync the visible editor before sending");
assert.ok(normalizeIndex > syncIndex, "normalization must happen after the final rich-editor sync");
assert.ok(editIndex > normalizeIndex, "edits must use the same normalized transport text");
assert.match(delivery, /window\.yachatMessageBoundaryBreaks\?\.normalize/);
assert.doesNotMatch(delivery, /const text = String\(transport\.value \|\| ""\)\.trim\(\)/);

assert.match(migration, /before insert or update of text on public\.yachat_messages/i);
assert.match(migration, /before insert or update of text on public\.yachat_system_messages/i);
assert.match(migration, /Existing history is intentionally not rewritten/);
assert.doesNotMatch(migration, /update\s+public\.yachat_(?:system_)?messages\s+set/i);

console.log("message boundary trim regression passed");

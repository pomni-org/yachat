import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [
  app,
  messageSearch,
  messageSearchCss,
  deviceLogin,
  buildScript,
  policy
] = await Promise.all([
  readFile(new URL("../src/renderer/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/renderer/assets/message-search.js", import.meta.url), "utf8"),
  readFile(new URL("../src/renderer/assets/message-search.css", import.meta.url), "utf8"),
  readFile(new URL("../src/renderer/assets/system-upgrade-v29.js", import.meta.url), "utf8"),
  readFile(new URL("../scripts/build-vercel.cjs", import.meta.url), "utf8"),
  readFile(new URL("../src/renderer/moderation.html", import.meta.url), "utf8")
]);

assert.match(app, /requestReportReason\(\{ kind: "message" \}\)/);
assert.match(app, /reason\s*\n?\s*\}\);/);
assert.match(app, /reason\.length < 3/);
assert.match(app, /message\.systemNotice/);
assert.match(app, /chat\.deletedAccount !== true/);

assert.match(messageSearch, /dialogHead\.append\(searchBar\)/);
assert.doesNotMatch(messageSearch, /dialogHead\.before\(searchBar\)/);
assert.match(messageSearch, /input\.focus\(\{ preventScroll: true \}\);\s*input\.select\(\);/);
assert.match(messageSearchCss, /position:\s*absolute/);
assert.doesNotMatch(messageSearchCss, /grid-template-rows:\s*auto minmax/);

const setScreenIndex = deviceLogin.indexOf('setScreen?.("qr")');
const focusIndex = deviceLogin.indexOf("input?.focus({ preventScroll: true })", setScreenIndex);
const frameIndex = deviceLogin.indexOf("requestAnimationFrame", setScreenIndex);
assert.ok(setScreenIndex >= 0 && focusIndex > setScreenIndex && frameIndex > focusIndex);

assert.match(buildScript, /"mobile-input-focus\.js"/);
assert.match(buildScript, /"moderation-ui\.css"/);
assert.match(policy, /Контент 18\+/);
assert.match(policy, /не являются основанием для блокировки/);
assert.match(policy, /Один двусмысленный намёк/);

console.log("moderation and mobile UX regression passed");

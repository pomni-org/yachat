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
  <head>
    <style>
      .profile-edit-avatar-preview {
        display: block;
        width: 120px;
        height: 120px;
        overflow: hidden;
        border-radius: 50%;
      }
      .profile-edit-avatar-preview img {
        width: 100%;
        height: 100%;
      }
    </style>
  </head>
  <body>
    <button class="profile-edit-avatar-preview" type="button">
      <img id="existing-profile-avatar" alt="">
    </button>
  </body>
</html>`);

const fixture = await page.evaluate(() => {
  const smallSource = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='100' viewBox='0 0 300 100'%3E%3Crect width='100' height='100' fill='%23f00'/%3E%3Crect x='100' width='100' height='100' fill='%230f0'/%3E%3Crect x='200' width='100' height='100' fill='%2300f'/%3E%3C/svg%3E";
  const oversizedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1200" viewBox="0 0 2400 1200"><metadata>${"x".repeat(3_700_000)}</metadata><rect width="800" height="1200" fill="#f00"/><rect x="800" width="800" height="1200" fill="#0f0"/><rect x="1600" width="800" height="1200" fill="#00f"/></svg>`;
  const oversizedSource = `data:image/svg+xml;base64,${btoa(oversizedSvg)}`;
  const positionedOversized = `${oversizedSource}#yachat-avatar-position=0.4000,-0.2000,1.7000`;

  globalThis.state = { language: "ru" };
  globalThis.cropToDataUrl = (source) => source;
  globalThis.__existingProfileAvatarFixture = positionedOversized;
  globalThis.readAvatarFile = async () => globalThis.__existingProfileAvatarFixture;

  return {
    smallSource,
    positionedOversized,
    originalLength: positionedOversized.length
  };
});

await page.addStyleTag({ path: "src/renderer/assets/avatar-preserve.css" });
await page.addScriptTag({ path: "src/renderer/assets/avatar-preserve.js" });

const result = await page.evaluate(async ({ smallSource }) => {
  const prepared = await readAvatarFile({ name: "phone-photo.svg", type: "image/svg+xml" });
  const parsed = window.yachatAvatarPosition.split(prepared);
  const unchangedSmall = await window.yachatAvatarPosition.prepare(`${smallSource}#yachat-avatar-position=0.1000,0.2000,1.3000`);
  const image = document.querySelector("#existing-profile-avatar");
  image.src = prepared;

  return {
    prepared,
    preparedLength: prepared.length,
    source: parsed.source,
    positioned: parsed.positioned,
    x: parsed.x,
    y: parsed.y,
    zoom: parsed.zoom,
    unchangedSmall,
    maximum: window.yachatAvatarPosition.maxStorageLength,
    storageMode: document.documentElement.dataset.yachatAvatarStorage || ""
  };
}, fixture);

await page.waitForFunction(() => {
  const image = document.querySelector("#existing-profile-avatar");
  return image?.classList.contains("is-yachat-positioned-avatar") && image.naturalWidth > 0 && image.naturalHeight > 0;
});

const rendered = await page.evaluate(() => {
  const image = document.querySelector("#existing-profile-avatar");
  return {
    src: image.getAttribute("src"),
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    objectFit: getComputedStyle(image).objectFit,
    positionX: image.style.getPropertyValue("--yachat-avatar-position-x"),
    positionY: image.style.getPropertyValue("--yachat-avatar-position-y"),
    zoom: image.style.getPropertyValue("--yachat-avatar-zoom")
  };
});

console.log(`[avatar-console] existing profile source: ${fixture.originalLength} -> ${result.preparedLength} characters`);

assert.ok(fixture.originalLength > 3_500_000, "fixture must reproduce the server-truncation range");
assert.ok(result.preparedLength <= result.maximum, "existing profile must never post an avatar above the safe storage limit");
assert.match(result.source, /^data:image\/webp/, "oversized photos must be normalized as a full-frame WebP");
assert.equal(result.positioned, true);
assert.equal(result.x, 0.4);
assert.equal(result.y, -0.2);
assert.equal(result.zoom, 1.7);
assert.equal(result.storageMode, "safe-full-frame-v1");
assert.equal(result.unchangedSmall, `${fixture.smallSource}#yachat-avatar-position=0.1000,0.2000,1.3000`, "small avatars must remain byte-for-byte untouched");
assert.ok(rendered.naturalWidth > rendered.naturalHeight, "the complete landscape composition must remain landscape");
assert.equal(rendered.objectFit, "cover");
assert.equal(rendered.positionX, "70%");
assert.equal(rendered.positionY, "40%");
assert.equal(rendered.zoom, "1.7");
assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join("\n")}`);

await browser.close();
console.log("existing profile avatar console suite passed");
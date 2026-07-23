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

const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0X8AAAAASUVORK5CYII=",
  "base64"
);

await page.route("https://yachat.test/**", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith(".png")) {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: transparentPng
    });
    return;
  }

  await route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><html><body></body></html>"
  });
});

await page.goto("https://yachat.test/");

const wideAvatar = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='100' viewBox='0 0 300 100'%3E%3Crect width='300' height='100' fill='%23555'/%3E%3C/svg%3E";

await page.setContent(`<!doctype html>
<html>
  <head>
    <style>
      .avatar-box,
      .chat-avatar,
      .profile-edit-avatar-preview,
      .avatar-modal-image {
        width: 120px;
        height: 120px;
        overflow: hidden;
        border-radius: 50%;
      }
      .avatar-box img,
      .chat-avatar img,
      .profile-edit-avatar-preview img,
      .avatar-modal-image img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        transform: scale(1.4);
      }
      .digital-id-identity-card > img {
        width: 92px;
        height: 92px;
        object-fit: cover;
      }
      .attachment-preview-media img {
        width: 100px;
        height: 100px;
      }
    </style>
  </head>
  <body>
    <div class="chat-avatar"><img id="chat-avatar" src="${wideAvatar}" alt=""></div>
    <button class="profile-edit-avatar-preview"><img id="profile-avatar" src="${wideAvatar}" alt=""></button>
    <div class="avatar-modal-image" data-avatar-modal-image><img id="modal-avatar" src="${wideAvatar}" alt=""></div>
    <div class="avatar-box" data-avatar-view><img id="data-avatar" src="${wideAvatar}" alt=""></div>
    <section class="digital-id-identity-card"><img id="digital-brand" src="/assets/yachat-brand-180.png?v=81" alt=""></section>
    <div class="attachment-preview-media"><img id="attachment" src="${wideAvatar}" alt=""></div>
  </body>
</html>`);

await page.addStyleTag({ path: "src/renderer/assets/avatar-preserve.css" });
await page.addScriptTag({ path: "src/renderer/assets/avatar-preserve.js" });
await page.waitForFunction(() => document.querySelector("#digital-brand")?.src.includes("yachat-brand-512.png?v=82"));

const initial = await page.evaluate(() => {
  const snapshot = (selector) => {
    const image = document.querySelector(selector);
    const style = getComputedStyle(image);
    return {
      objectFit: style.objectFit,
      objectPosition: style.objectPosition,
      transform: style.transform,
      width: image.getBoundingClientRect().width,
      height: image.getBoundingClientRect().height,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight
    };
  };

  return {
    chat: snapshot("#chat-avatar"),
    profile: snapshot("#profile-avatar"),
    modal: snapshot("#modal-avatar"),
    dataAvatar: snapshot("#data-avatar"),
    attachmentFit: getComputedStyle(document.querySelector("#attachment")).objectFit,
    digitalSource: document.querySelector("#digital-brand").getAttribute("src"),
    digitalWidth: document.querySelector("#digital-brand").getBoundingClientRect().width,
    digitalHeight: document.querySelector("#digital-brand").getBoundingClientRect().height
  };
});

for (const [name, avatar] of Object.entries({
  chat: initial.chat,
  profile: initial.profile,
  modal: initial.modal,
  dataAvatar: initial.dataAvatar
})) {
  assert.equal(avatar.objectFit, "contain", `${name} must preserve the complete image`);
  assert.equal(avatar.objectPosition, "50% 50%", `${name} must stay centered`);
  assert.equal(avatar.transform, "none", `${name} must not be enlarged or shifted`);
  assert.equal(avatar.width, 120, `${name} must use the container width`);
  assert.equal(avatar.height, 120, `${name} must use the container height`);
  assert.equal(avatar.naturalWidth, 300, `${name} must retain the source width`);
  assert.equal(avatar.naturalHeight, 100, `${name} must retain the source height`);
}

assert.notEqual(initial.attachmentFit, "contain", "ordinary attachment previews must not be changed by avatar rules");
assert.equal(initial.digitalSource, "/assets/yachat-brand-512.png?v=82");
assert.equal(initial.digitalWidth, 92, "high-resolution replacement must not change the designed box size");
assert.equal(initial.digitalHeight, 92, "high-resolution replacement must not change the designed box size");

await page.evaluate(() => {
  const card = document.createElement("section");
  card.className = "digital-id-identity-card";
  card.innerHTML = '<img id="dynamic-brand" src="/assets/yachat-brand-64.png?v=50" alt="">';
  document.body.append(card);
});

await page.waitForFunction(() => document.querySelector("#dynamic-brand")?.src.includes("yachat-brand-512.png?v=82"));
const dynamicSource = await page.locator("#dynamic-brand").getAttribute("src");
assert.equal(dynamicSource, "/assets/yachat-brand-512.png?v=82", "dynamically rendered settings must also use the full-resolution asset");

assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join("\n")}`);

await browser.close();
console.log("avatar preservation suite passed");

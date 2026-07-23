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

const wideAvatar = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='100' viewBox='0 0 300 100'%3E%3Crect width='100' height='100' fill='%23f00'/%3E%3Crect x='100' width='100' height='100' fill='%230f0'/%3E%3Crect x='200' width='100' height='100' fill='%2300f'/%3E%3C/svg%3E";
const positionedAvatar = `${wideAvatar}#yachat-avatar-position=1.0000,-1.0000,1.5000`;

await page.setContent(`<!doctype html>
<html>
  <head>
    <style>
      .chat-avatar,
      .profile-edit-avatar-preview,
      .avatar-modal-image,
      [data-avatar-view] {
        box-sizing: border-box;
        width: 120px;
        height: 120px;
        padding: 0;
        overflow: hidden;
        border: 0;
        border-radius: 50%;
      }
      img[data-avatar-modal-image] {
        display: block;
        width: 240px;
        height: 240px;
        object-fit: cover;
        transform: scale(1.4);
      }
      .chat-avatar img,
      .profile-edit-avatar-preview img,
      .avatar-modal-image img,
      [data-avatar-view] img {
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
    <div class="chat-avatar"><img id="plain-avatar" src="${wideAvatar}" alt=""></div>
    <div class="chat-avatar"><img id="positioned-avatar" src="${positionedAvatar}" alt=""></div>
    <button class="profile-edit-avatar-preview"><img id="profile-avatar" src="${wideAvatar}" alt=""></button>
    <div class="avatar-modal-image" data-avatar-modal-image><img id="modal-avatar" src="${wideAvatar}" alt=""></div>
    <div data-avatar-view><img id="viewer-avatar" src="${positionedAvatar}" alt=""></div>
    <img id="fullscreen-avatar" data-avatar-modal-image src="${positionedAvatar}" alt="">
    <section class="digital-id-identity-card"><img id="digital-brand" src="/assets/yachat-brand-180.png?v=81" alt=""></section>
    <div class="attachment-preview-media"><img id="attachment" src="${wideAvatar}" alt=""></div>
  </body>
</html>`);

await page.evaluate(() => {
  globalThis.state = { language: "ru" };
  globalThis.cropToDataUrl = () => "destructive-square-webp";
  globalThis.readAvatarFile = () => "reader-preserved";
  globalThis.createLocalDigitalId = () => "BROKEN";
  globalThis.formatLocalDigitalId = () => "BROKEN";
});

await page.addStyleTag({ path: "src/renderer/assets/avatar-preserve.css" });
await page.addScriptTag({ path: "src/renderer/assets/avatar-preserve.js" });
await page.waitForFunction(() => document.querySelector("#digital-brand")?.getAttribute("src") === "/assets/yachat-brand-512.png?v=83");
await page.waitForFunction(() => document.querySelector("#positioned-avatar")?.classList.contains("is-yachat-positioned-avatar"));
await page.waitForFunction(() => document.querySelector("#fullscreen-avatar")?.classList.contains("is-yachat-positioned-avatar"));

const cropResult = await page.evaluate((source) => ({
  encoded: cropToDataUrl(source, { x: 0.4, y: -0.2, zoom: 1.7 }),
  reader: readAvatarFile(),
  mode: document.documentElement.dataset.yachatAvatarUpload || ""
}), wideAvatar);

assert.equal(cropResult.encoded, `${wideAvatar}#yachat-avatar-position=0.4000,-0.2000,1.7000`);
assert.ok(cropResult.encoded.startsWith(wideAvatar), "positioning must retain the complete original source");
assert.equal(cropResult.reader, "reader-preserved", "the crop UI reader must remain available");
assert.equal(cropResult.mode, "positioned-original-v2");

const avatarState = await page.evaluate(() => {
  const snapshot = (selector) => {
    const image = document.querySelector(selector);
    const style = getComputedStyle(image);
    return {
      src: image.getAttribute("src"),
      objectFit: style.objectFit,
      objectPosition: style.objectPosition,
      transform: style.transform,
      inlinePositionX: image.style.getPropertyValue("--yachat-avatar-position-x"),
      inlinePositionY: image.style.getPropertyValue("--yachat-avatar-position-y"),
      inlineZoom: image.style.getPropertyValue("--yachat-avatar-zoom"),
      width: image.getBoundingClientRect().width,
      height: image.getBoundingClientRect().height,
      layoutWidth: image.offsetWidth,
      layoutHeight: image.offsetHeight,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight
    };
  };
  return {
    plain: snapshot("#plain-avatar"),
    positioned: snapshot("#positioned-avatar"),
    profile: snapshot("#profile-avatar"),
    modal: snapshot("#modal-avatar"),
    viewer: snapshot("#viewer-avatar"),
    fullscreen: snapshot("#fullscreen-avatar"),
    attachmentFit: getComputedStyle(document.querySelector("#attachment")).objectFit,
    digitalSource: document.querySelector("#digital-brand").getAttribute("src"),
    digitalWidth: document.querySelector("#digital-brand").getBoundingClientRect().width,
    digitalHeight: document.querySelector("#digital-brand").getBoundingClientRect().height
  };
});

for (const [name, avatar] of Object.entries({
  plain: avatarState.plain,
  profile: avatarState.profile,
  modal: avatarState.modal
})) {
  assert.equal(avatar.objectFit, "contain", `${name} must preserve the complete image by default`);
  assert.equal(avatar.objectPosition, "50% 50%", `${name} must stay centered by default`);
  assert.equal(avatar.transform, "none", `${name} must not be enlarged without saved positioning`);
  assert.equal(avatar.naturalWidth, 300, `${name} must retain the source width`);
  assert.equal(avatar.naturalHeight, 100, `${name} must retain the source height`);
}

for (const [name, avatar] of Object.entries({
  positioned: avatarState.positioned,
  viewer: avatarState.viewer,
  fullscreen: avatarState.fullscreen
})) {
  assert.equal(avatar.src, wideAvatar, `${name} must load the untouched original source`);
  assert.equal(avatar.objectFit, "cover", `${name} must render the saved position in its frame`);
  assert.equal(avatar.inlinePositionX, "100%");
  assert.equal(avatar.inlinePositionY, "0%");
  assert.equal(avatar.inlineZoom, "1.5");
  assert.notEqual(avatar.transform, "none", `${name} must render saved zoom visually`);
  assert.equal(avatar.naturalWidth, 300);
  assert.equal(avatar.naturalHeight, 100);
}

assert.equal(avatarState.plain.width, 120);
assert.equal(avatarState.plain.height, 120);
assert.equal(avatarState.fullscreen.layoutWidth, 240);
assert.equal(avatarState.fullscreen.layoutHeight, 240);
assert.equal(avatarState.fullscreen.width, 360);
assert.equal(avatarState.fullscreen.height, 360);
assert.notEqual(avatarState.attachmentFit, "contain", "ordinary attachment previews must not be changed by avatar rules");
assert.equal(avatarState.digitalSource, "/assets/yachat-brand-512.png?v=83");
assert.equal(avatarState.digitalWidth, 92);
assert.equal(avatarState.digitalHeight, 92);

const digitalIds = await page.evaluate(() => {
  const latin = Array.from({ length: 400 }, () => window.yachatDigitalId.generate("latin"));
  const cyrillic = Array.from({ length: 400 }, () => window.yachatDigitalId.generate("cyrillic"));
  return {
    latin,
    cyrillic,
    formattedLatin: window.yachatDigitalId.format("RKH399"),
    formattedCyrillic: window.yachatDigitalId.format("РКН399"),
    formattedCyrillicExtended: window.yachatDigitalId.format("ЩЮЯ399"),
    mixed: window.yachatDigitalId.format("RКН399"),
    localRu: createLocalDigitalId(),
    mode: document.documentElement.dataset.yachatDigitalId || ""
  };
});

assert.ok(digitalIds.latin.every((value) => /^(?:[ABCDEFGHJKLMNPQRSTUVWXYZ]{2}\d{4}|[ABCDEFGHJKLMNPQRSTUVWXYZ]{3}\d{3})$/.test(value)));
assert.ok(digitalIds.cyrillic.every((value) => /^(?:[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{2}\d{4}|[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{3}\d{3})$/.test(value)));
assert.equal(digitalIds.formattedLatin, "RKH — 399");
assert.equal(digitalIds.formattedCyrillic, "РКН — 399");
assert.equal(digitalIds.formattedCyrillicExtended, "ЩЮЯ — 399");
assert.equal(digitalIds.mixed, "", "mixed scripts must never be accepted as one Digital ID");
assert.match(digitalIds.localRu, /^(?:[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{2}\d{4}|[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{3}\d{3})$/);
assert.equal(digitalIds.mode, "single-script-v1");

await page.evaluate(() => {
  const card = document.createElement("section");
  card.className = "digital-id-identity-card";
  card.innerHTML = '<img id="dynamic-brand" src="/assets/yachat-brand-64.png?v=50" alt="">';
  document.body.append(card);
});
await page.waitForFunction(() => document.querySelector("#dynamic-brand")?.getAttribute("src") === "/assets/yachat-brand-512.png?v=83");

assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join("\n")}`);

await browser.close();
console.log("avatar positioning and digital id suite passed");
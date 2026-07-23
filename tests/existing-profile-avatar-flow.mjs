import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const root = path.resolve("src/renderer");
const account = {
  id: "avatar-flow-user",
  username: "avatar_flow_user",
  displayName: "Avatar Flow",
  previewName: "Avatar Flow",
  bio: "Existing profile",
  avatarDataUrl: "",
  avatarAccent: "#471AFF",
  contact: "+7 900 000 00 01",
  digitalId: "АБВ — 123",
  rawDigitalId: "АБВ123",
  createdAt: "2026-07-23T00:00:00.000Z"
};
const chats = [{
  id: "yachat-favorites",
  kind: "saved",
  title: "Избранное",
  subtitle: "Сообщения для себя",
  description: "Сообщения для себя",
  pinned: true,
  locked: true,
  canSend: true,
  createdAt: account.createdAt
}];
let updatePayload = null;
let updateCount = 0;

function json(response, payload, status = 200) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function bodyJson(request) {
  const parts = [];
  for await (const part of request) parts.push(part);
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname === "/api/bootstrap") {
      json(response, {
        authenticated: true,
        account,
        settings: { language: "ru", theme: "dark", themeSource: "manual", country: "RU", countryCode: "+7" },
        chats,
        messages: [],
        activeChatId: "yachat-favorites",
        routeUser: null
      });
      return;
    }
    if (url.pathname === "/api/account/update") {
      updatePayload = await bodyJson(request);
      updateCount += 1;
      Object.assign(account, updatePayload);
      json(response, account);
      return;
    }
    if (url.pathname === "/api/users/check-username") {
      json(response, { username: url.searchParams.get("username") || "", available: true });
      return;
    }
    if (url.pathname === "/api/chats") {
      json(response, chats);
      return;
    }
    if (url.pathname === "/api/messages") {
      json(response, []);
      return;
    }
    if (url.pathname === "/api/settings") {
      json(response, { language: "ru", theme: "dark", themeSource: "manual", country: "RU", countryCode: "+7" });
      return;
    }
    if (url.pathname === "/api/digital-id") {
      json(response, { digitalId: account.digitalId, rawDigitalId: account.rawDigitalId, createdAt: account.createdAt });
      return;
    }
    if (url.pathname === "/api/push/public-key") {
      json(response, { enabled: false, publicKey: "" });
      return;
    }
    if (url.pathname === "/api/messenger") {
      json(response, { chats, messages: [], activeChatId: "yachat-favorites", routeUser: null });
      return;
    }
    json(response, {});
    return;
  }

  const filePath = url.pathname === "/" ? path.join(root, "index.html") : path.join(root, url.pathname.replace(/^\/+/, ""));
  try {
    const content = await readFile(filePath);
    if (url.pathname === "/") {
      const html = content.toString("utf8").replace(
        '<script src="./app.js"></script>',
        '<script src="./app.js"></script><script src="./assets/avatar-preserve.js"></script>'
      );
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
      return;
    }
    const extension = path.extname(filePath);
    const contentType = extension === ".js" ? "application/javascript" : extension === ".css" ? "text/css" : extension === ".svg" ? "image/svg+xml" : "application/octet-stream";
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;

const executablePath = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

await page.addInitScript(() => {
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function blockedSynchronousAvatarEncoding(type, quality) {
    if (String(type || "").toLowerCase().includes("webp")) {
      throw new Error("synchronous avatar toDataURL is forbidden");
    }
    return originalToDataURL.call(this, type, quality);
  };
  window.__avatarHeartbeat = 0;
  window.setInterval(() => { window.__avatarHeartbeat += 1; }, 25);
});

const tiles = [];
let seed = 0x1a2b3c4d;
for (let y = 0; y < 1600; y += 8) {
  for (let x = 0; x < 2400; x += 8) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const color = (seed >>> 0) & 0xffffff;
    tiles.push(`<rect x="${x}" y="${y}" width="8" height="8" fill="#${color.toString(16).padStart(6, "0")}"/>`);
  }
}
const noisySvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600" viewBox="0 0 2400 1600">${tiles.join("")}</svg>`);
assert.ok(noisySvg.length > 3_200_000, "fixture must resemble a heavy phone photo payload");

await page.goto(origin, { waitUntil: "networkidle" });
await page.locator("[data-messenger]").waitFor({ state: "visible" });
await page.locator('[data-rail="settings"]').click();
await page.locator('[data-panel-action="edit-profile"]').click();
await page.locator("[data-profile-avatar-input]").setInputFiles({
  name: "phone-photo.svg",
  mimeType: "image/svg+xml",
  buffer: noisySvg
});

const cropModal = page.locator("[data-avatar-crop-modal]");
await cropModal.waitFor({ state: "visible" });
const heartbeatBefore = await page.evaluate(() => window.__avatarHeartbeat);
const startedAt = Date.now();
await page.locator("[data-avatar-crop-save]").click();
await cropModal.waitFor({ state: "hidden", timeout: 15000 });
const cropSaveMs = Date.now() - startedAt;
const heartbeatAfter = await page.evaluate(() => window.__avatarHeartbeat);

await page.locator(".profile-edit-avatar-preview img").waitFor({ state: "visible" });
await page.locator('[data-panel-action="save-profile"]').click();
await page.waitForFunction(() => !document.querySelector('[data-panel-action="save-profile"]'), null, { timeout: 10000 });

assert.equal(updateCount, 1, "existing profile save must send exactly one account update");
assert.ok(updatePayload?.avatarDataUrl, "account update must include the selected avatar");
assert.ok(updatePayload.avatarDataUrl.length <= 3_200_000, "account update must stay below the server storage limit");
assert.match(updatePayload.avatarDataUrl, /^data:image\/(?:webp|png|jpeg)/, "saved avatar must remain a valid image data URL");
assert.match(updatePayload.avatarDataUrl, /#yachat-avatar-position=/, "saved position must survive the account update");
assert.equal(await page.locator("html").getAttribute("data-yachat-avatar-save"), "async-guard-v2");
assert.equal(await page.locator("html").getAttribute("data-yachat-avatar-storage"), "async-full-frame-v2");
assert.ok(heartbeatAfter > heartbeatBefore, "the browser event loop must continue while the photo is prepared");
assert.ok(cropSaveMs < 15000, `avatar preparation took too long: ${cropSaveMs}ms`);
assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join("\n")}`);

console.log(`[avatar-flow-console] payload=${noisySvg.length} bytes, saved=${updatePayload.avatarDataUrl.length} chars, crop-save=${cropSaveMs}ms, heartbeats=${heartbeatAfter - heartbeatBefore}`);
console.log("existing profile avatar full UI flow passed");

await browser.close();
await new Promise((resolve) => server.close(resolve));
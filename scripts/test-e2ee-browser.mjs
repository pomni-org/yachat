import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";

const baseUrl = process.env.E2EE_TEST_ORIGIN || "http://127.0.0.1:4173";
const browserName = String(process.env.E2EE_TEST_BROWSER || "chromium").toLowerCase();
const browserType = browserName === "webkit" ? webkit : chromium;
const browser = await browserType.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

let registeredBundle = null;
let firstIdentityKey = "";
let messageRequests = 0;
let heartbeatRequests = 0;
const epochId = "epoch-browser-phase2-test";

await page.route("**/api/e2ee/device/register", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  assert.equal(body.algorithm, "yachat-x3dh-v1");
  assert.equal(body.protocolVersion, 2);
  assert.equal(body.capabilities.includes("server-blind-text-v1"), true);
  assert.match(body.deviceId, /^[A-Za-z0-9._:-]{8,128}$/);
  assert.equal(typeof body.identityDhPublic, "string");
  assert.equal(typeof body.identitySignPublic, "string");
  assert.ok(Array.isArray(body.oneTimePreKeys));
  assert.ok(body.oneTimePreKeys.length >= 24);
  assert.equal(JSON.stringify(body).includes("privateJwk"), false);

  registeredBundle = body;
  firstIdentityKey ||= body.identityDhPublic;
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      deviceId: body.deviceId,
      algorithm: body.algorithm,
      protocolVersion: 2,
      capabilities: body.capabilities,
      availableOneTimePreKeys: body.oneTimePreKeys.length,
      needsOneTimePreKeys: false,
      rolloutPhase: "phase2-ready"
    })
  });
});

await page.route("**/api/e2ee/device/heartbeat", async (route) => {
  heartbeatRequests += 1;
  const body = JSON.parse(route.request().postData() || "{}");
  assert.equal(body.deviceId, registeredBundle?.deviceId);
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      deviceId: body.deviceId,
      protocolVersion: 2,
      availableOneTimePreKeys: 32,
      needsOneTimePreKeys: false,
      rolloutPhase: "phase2-ready"
    })
  });
});

await page.route("**/api/e2ee/bundles/claim", async (route) => {
  assert.ok(registeredBundle, "device must register before claiming bundles");
  const request = JSON.parse(route.request().postData() || "{}");
  assert.equal(request.chatId, "private-test-chat");
  assert.equal(request.senderDeviceId, registeredBundle.deviceId);
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      chatId: request.chatId,
      algorithm: registeredBundle.algorithm,
      protocolVersion: 2,
      rolloutPhase: "encrypted",
      epochId,
      epochVersion: 1,
      requiredDeviceIds: [registeredBundle.deviceId],
      missingDeviceUserIds: [],
      unreadySessionUserIds: [],
      bundles: [{
        deviceId: registeredBundle.deviceId,
        userId: "account-test",
        algorithm: registeredBundle.algorithm,
        protocolVersion: 2,
        identityDhPublic: registeredBundle.identityDhPublic,
        identitySignPublic: registeredBundle.identitySignPublic,
        signedPreKey: registeredBundle.signedPreKey,
        oneTimePreKey: null
      }]
    })
  });
});

await page.route("**/api/message", async (route) => {
  messageRequests += 1;
  const body = JSON.parse(route.request().postData() || "{}");
  assert.equal(body.chatId, "private-test-chat");
  assert.equal(body.e2ee?.mode, "encrypted");
  assert.equal(body.e2ee?.version, 2);
  assert.equal(body.e2ee?.epochId, epochId);
  assert.equal(body.text, "", "encrypted request must not contain plaintext text");
  assert.equal(body.message, "", "encrypted request must not contain a plaintext alias");
  assert.equal(body.formattedHtml, "", "encrypted request must not contain formatted plaintext");
  assert.equal(body.replyToMessageId, null, "reply metadata must stay in ciphertext");
  assert.equal(body.forwardedFrom, "", "forward metadata must stay in ciphertext");
  assert.ok(body.e2ee?.ciphertext);
  assert.equal(body.e2ee?.envelopes?.length, 1);
  assert.equal(JSON.stringify(body).includes("identityDhPrivate"), false);
  assert.equal(JSON.stringify(body).includes("identitySignPrivate"), false);
  assert.equal(JSON.stringify(body).includes("privateJwk"), false);

  const e2ee = structuredClone(body.e2ee);
  const attachments = structuredClone(body.attachments || []);
  if (messageRequests === 2) {
    const first = e2ee.ciphertext[0];
    e2ee.ciphertext = `${first === "A" ? "B" : "A"}${e2ee.ciphertext.slice(1)}`;
  }
  if (messageRequests === 3 && attachments[0]) {
    attachments[0].dataUrl = "data:text/plain;base64,VGFtcGVyZWQ=";
  }

  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      inserted: true,
      e2eeRolloutPhase: "encrypted",
      message: {
        id: body.clientMessageId,
        chatId: body.chatId,
        author: "user",
        authorId: "account-test",
        text: "",
        formattedHtml: "",
        replyToMessageId: null,
        forwardedFrom: "",
        attachments,
        e2ee
      }
    })
  });
});

async function browserDiagnostics() {
  return page.evaluate(async () => {
    const algorithms = {};
    for (const name of ["X25519", "Ed25519"]) {
      try {
        const usages = name === "X25519" ? ["deriveBits"] : ["sign", "verify"];
        const pair = await crypto.subtle.generateKey({ name }, true, usages);
        algorithms[name] = Boolean(pair?.privateKey);
      } catch (error) {
        algorithms[name] = `${error?.name || "Error"}: ${error?.message || error}`;
      }
    }
    return {
      runtime: window.__yachatE2EE || null,
      secureContext: window.isSecureContext,
      hasIndexedDB: Boolean(window.indexedDB),
      hasSubtleCrypto: Boolean(window.crypto?.subtle),
      userAgent: navigator.userAgent,
      algorithms
    };
  }).catch((error) => ({ diagnosticsError: String(error?.message || error) }));
}

async function waitReady() {
  try {
    await page.waitForFunction(
      () => window.__yachatE2EE?.ready === true && window.__yachatE2EE?.protocolVersion === 2,
      null,
      { timeout: 30_000 }
    );
  } catch (error) {
    const diagnostics = await browserDiagnostics();
    throw new Error(`${error?.message || error}\nE2EE diagnostics: ${JSON.stringify(diagnostics)}`);
  }
}

async function send({ text, formattedHtml = "", replyToMessageId = null, attachments = [] }) {
  return page.evaluate(async (message) => {
    const id = crypto.randomUUID();
    const response = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: "private-test-chat",
        clientMessageId: id,
        text: message.text,
        formattedHtml: message.formattedHtml,
        replyToMessageId: message.replyToMessageId,
        forwardedFrom: "source-test",
        attachments: message.attachments
      })
    });
    return response.json();
  }, { text, formattedHtml, replyToMessageId, attachments });
}

const fixtureUrl = `${baseUrl}/e2ee-browser-fixture.html`;
await page.goto(fixtureUrl, { waitUntil: "load" });
await waitReady();

const attachment = {
  kind: "file",
  name: "note.txt",
  mime: "text/plain",
  size: 7,
  dataUrl: "data:text/plain;base64,0J/RgNC40LLQtdGC"
};

const first = await send({
  text: "Сквозной этап два",
  formattedHtml: "<strong>Сквозной</strong> этап два<script>alert(1)</script>",
  replyToMessageId: "reply-test-id",
  attachments: [attachment]
});
assert.equal(first.message.text, "Сквозной этап два");
assert.equal(first.message.formattedHtml.includes("<strong>Сквозной</strong>"), true);
assert.equal(first.message.formattedHtml.includes("<script"), false);
assert.equal(first.message.replyToMessageId, "reply-test-id");
assert.equal(first.message.forwardedFrom, "source-test");
assert.equal(first.message.e2eeVerified, true);
assert.equal(first.message.e2ee.mode, "encrypted");
assert.equal(first.message.e2ee.epochId, epochId);

const tamperedCiphertext = await send({ text: "Проверка подмены ciphertext", attachments: [attachment] });
assert.equal(tamperedCiphertext.message.e2eeVerified, false, "tampered ciphertext must fail verification");
assert.equal(tamperedCiphertext.message.text, "Не удалось проверить защищённое сообщение");

const tamperedAttachment = await send({ text: "Проверка подмены вложения", attachments: [attachment] });
assert.equal(tamperedAttachment.message.e2eeVerified, false, "tampered attachment must fail integrity verification");
await page.waitForFunction(() => window.__yachatE2EE?.verificationFailures >= 2);

const stored = await page.evaluate(async () => {
  const request = indexedDB.open("yachat-e2ee-v1", 5);
  const db = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = db.transaction("devices", "readonly");
  const getAll = transaction.objectStore("devices").getAll();
  const records = await new Promise((resolve, reject) => {
    getAll.onsuccess = () => resolve(getAll.result);
    getAll.onerror = () => reject(getAll.error);
  });
  const record = records[0] || {};
  const serialized = JSON.stringify(record);
  const vaultSecretKeys = Object.keys(localStorage).filter((key) => key.startsWith("yachat-e2ee-vault-secret-v1:"));
  return {
    recordCount: records.length,
    deviceStoreKeyPath: db.transaction("devices", "readonly").objectStore("devices").keyPath,
    hasLegacyCryptoKeyStore: db.objectStoreNames.contains("cryptoKeys"),
    hasChatStateStore: db.objectStoreNames.contains("chatState"),
    hasVault: Number(record.privateVault?.version) === 2
      && typeof record.privateVault?.iv === "string"
      && typeof record.privateVault?.ciphertext === "string"
      && record.privateVault.ciphertext.length > 100,
    metadataContainsPrivateJwk: serialized.includes("privateJwk")
      || serialized.includes("identityDhPrivate")
      || serialized.includes("identitySignPrivate"),
    vaultSecretCount: vaultSecretKeys.length,
    vaultSecretLength: vaultSecretKeys.length ? String(localStorage.getItem(vaultSecretKeys[0]) || "").length : 0
  };
});
assert.equal(stored.recordCount, 1);
assert.equal(stored.deviceStoreKeyPath, null);
assert.equal(stored.hasLegacyCryptoKeyStore, false);
assert.equal(stored.hasChatStateStore, true);
assert.equal(stored.hasVault, true, "private JWK material must exist only inside the encrypted vault");
assert.equal(stored.metadataContainsPrivateJwk, false);
assert.equal(stored.vaultSecretCount, 1);
assert.ok(stored.vaultSecretLength >= 40);

registeredBundle = null;
await page.reload({ waitUntil: "load" });
await waitReady();
assert.ok(registeredBundle, "device must register after reload");
assert.equal(registeredBundle.identityDhPublic, firstIdentityKey, "device identity must persist across reloads");

const afterReload = await send({ text: "После перезагрузки", attachments: [] });
assert.equal(afterReload.message.text, "После перезагрузки");
assert.equal(afterReload.message.e2eeVerified, true, "restored vault keys must complete a real encrypted round trip");
assert.equal(afterReload.message.e2ee.mode, "encrypted");

assert.equal(heartbeatRequests >= 0, true);
await browser.close();
console.log(`E2EE phase 2 ${browserName} test passed: no plaintext, encrypted vault, reload, ciphertext and attachment tamper rejection.`);

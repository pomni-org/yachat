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
let attachmentEncryptionReady = true;
const capturedMessageBodies = [];
const epochId = "epoch-browser-phase4-test";

await page.route("**/api/e2ee/device/register", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  assert.equal(body.algorithm, "yachat-x3dh-v1");
  assert.equal(body.protocolVersion, 4);
  assert.equal(body.capabilities.includes("server-blind-text-v1"), true);
  assert.equal(body.capabilities.includes("encrypted-attachments-v1"), true);
  assert.equal(body.capabilities.includes("encrypted-push-preview-v1"), true);
  assert.equal(typeof body.pushPreviewPublic, "string");
  assert.equal(typeof body.pushPreviewSignature, "string");
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
      protocolVersion: 4,
      capabilities: body.capabilities,
      availableOneTimePreKeys: body.oneTimePreKeys.length,
      needsOneTimePreKeys: false,
      rolloutPhase: "phase4-ready"
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
      protocolVersion: 4,
      availableOneTimePreKeys: 32,
      needsOneTimePreKeys: false,
      rolloutPhase: "phase4-ready"
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
      protocolVersion: 4,
      rolloutPhase: "encrypted",
      attachmentEncryptionReady,
      epochId,
      epochVersion: 1,
      requiredDeviceIds: [registeredBundle.deviceId],
      missingDeviceUserIds: [],
      unreadySessionUserIds: [],
      bundles: [{
        deviceId: registeredBundle.deviceId,
        userId: "account-test",
        algorithm: registeredBundle.algorithm,
        protocolVersion: 4,
        capabilities: registeredBundle.capabilities,
        pushPreview: {
          version: 1,
          algorithm: "P-256-HKDF-SHA256-AESGCM",
          publicKey: registeredBundle.pushPreviewPublic,
          signature: registeredBundle.pushPreviewSignature
        },
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
  capturedMessageBodies.push(structuredClone(body));
  assert.equal(body.chatId, "private-test-chat");
  assert.equal(body.e2ee?.mode, "encrypted");
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
    const [prefix, encoded = ""] = String(attachments[0].dataUrl || "").split(",", 2);
    const first = encoded[0] || "A";
    attachments[0].dataUrl = `${prefix},${first === "A" ? "B" : "A"}${encoded.slice(1)}`;
  }
  if (messageRequests === 4) {
    e2ee.attachmentMode = "plaintext";
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
    for (const name of ["X25519", "Ed25519", "P-256"]) {
      try {
        const usages = name === "Ed25519" ? ["sign", "verify"] : ["deriveBits"];
        const algorithm = name === "P-256"
          ? { name: "ECDH", namedCurve: "P-256" }
          : { name };
        const pair = await crypto.subtle.generateKey(algorithm, true, usages);
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
      () => window.__yachatE2EE?.ready === true && window.__yachatE2EE?.protocolVersion === 4,
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
  text: "Реальный текст этапа четыре",
  formattedHtml: "<strong>Реальный</strong> текст этапа четыре<script>alert(1)</script>",
  replyToMessageId: "reply-test-id",
  attachments: [attachment]
});
assert.equal(first.message.text, "Реальный текст этапа четыре");
assert.equal(first.message.formattedHtml.includes("<strong>Реальный</strong>"), true);
assert.equal(first.message.formattedHtml.includes("<script"), false);
assert.equal(first.message.replyToMessageId, "reply-test-id");
assert.equal(first.message.forwardedFrom, "source-test");
assert.equal(first.message.e2eeVerified, true);
assert.equal(first.message.e2ee.mode, "encrypted");
assert.equal(first.message.e2ee.epochId, epochId);
assert.equal(first.message.e2ee.version, 3);
assert.equal(first.message.e2ee.attachmentMode, "encrypted");
assert.equal(first.message.attachments[0].name, attachment.name);
assert.equal(first.message.attachments[0].mime, attachment.mime);
assert.equal(first.message.attachments[0].kind, attachment.kind);
assert.equal(first.message.attachments[0].dataUrl, attachment.dataUrl);
assert.equal(first.message.attachments[0].e2eeEncrypted, true);

const encryptedRequest = capturedMessageBodies[0];
assert.equal(encryptedRequest.e2ee.version, 3);
assert.equal(encryptedRequest.e2ee.attachmentMode, "encrypted");
assert.equal(encryptedRequest.attachments[0].name, "encrypted");
assert.equal(encryptedRequest.attachments[0].mime, "application/vnd.yachat.e2ee");
assert.equal(encryptedRequest.attachments[0].kind, "file");
assert.match(
  encryptedRequest.attachments[0].dataUrl,
  /^data:application\/vnd\.yachat\.e2ee;base64,/
);
assert.equal(JSON.stringify(encryptedRequest).includes(attachment.dataUrl), false);
assert.equal(JSON.stringify(encryptedRequest).includes("Реальный текст этапа четыре"), false);
assert.equal(encryptedRequest.e2ee.pushPreviews.length, 1);
assert.equal(encryptedRequest.e2ee.pushPreviews[0].version, 1);
assert.equal(encryptedRequest.e2ee.pushPreviews[0].deviceId, registeredBundle.deviceId);
assert.equal(encryptedRequest.e2ee.pushPreviews[0].ciphertext.length > 1300, true);

const serviceWorkerPromise = context.waitForEvent("serviceworker", { timeout: 15_000 }).catch(() => null);
await page.evaluate(async () => {
  await navigator.serviceWorker.register("/sw.js?e2ee-phase4-test=1", {
    scope: "/",
    updateViaCache: "none"
  });
  await navigator.serviceWorker.ready;
});
const previewWorker = await serviceWorkerPromise
  || context.serviceWorkers().find((worker) => worker.url().includes("/sw.js"));
assert.ok(previewWorker, "the phase 4 service worker must activate");
const notificationBody = await previewWorker.evaluate(
  async (preview) => decryptPushPreview(preview),
  encryptedRequest.e2ee.pushPreviews[0]
);
assert.equal(notificationBody, "Реальный текст этапа четыре");

const tamperedPushPreview = structuredClone(encryptedRequest.e2ee.pushPreviews[0]);
tamperedPushPreview.ciphertext = `${tamperedPushPreview.ciphertext[0] === "A" ? "B" : "A"}${tamperedPushPreview.ciphertext.slice(1)}`;
await assert.rejects(
  previewWorker.evaluate(async (preview) => decryptPushPreview(preview), tamperedPushPreview),
  "the service worker must reject a modified encrypted push preview"
);

const tamperedCiphertext = await send({ text: "Проверка подмены ciphertext", attachments: [attachment] });
assert.equal(tamperedCiphertext.message.e2eeVerified, false, "tampered ciphertext must fail verification");
assert.equal(tamperedCiphertext.message.text, "Не удалось проверить защищённое сообщение");

const tamperedAttachment = await send({ text: "Проверка подмены вложения", attachments: [attachment] });
assert.equal(tamperedAttachment.message.e2eeVerified, false, "tampered attachment must fail integrity verification");

const downgradedAttachmentMode = await send({ text: "Проверка downgrade", attachments: [attachment] });
assert.equal(downgradedAttachmentMode.message.e2eeVerified, false, "attachment-mode downgrade must fail verification");
await page.waitForFunction(() => window.__yachatE2EE?.verificationFailures >= 3);

const stored = await page.evaluate(async () => {
  const request = indexedDB.open("yachat-e2ee-v1", 6);
  const db = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const deviceTransaction = db.transaction("devices", "readonly");
  const getAll = deviceTransaction.objectStore("devices").getAll();
  const records = await new Promise((resolve, reject) => {
    getAll.onsuccess = () => resolve(getAll.result);
    getAll.onerror = () => reject(getAll.error);
  });
  const previewTransaction = db.transaction("pushPreviewKeys", "readonly");
  const previewRequest = previewTransaction.objectStore("pushPreviewKeys").getAll();
  const previewRecords = await new Promise((resolve, reject) => {
    previewRequest.onsuccess = () => resolve(previewRequest.result);
    previewRequest.onerror = () => reject(previewRequest.error);
  });
  const record = records[0] || {};
  const previewRecord = previewRecords[0] || {};
  const serialized = JSON.stringify(record);
  const vaultSecretKeys = Object.keys(localStorage).filter((key) => key.startsWith("yachat-e2ee-vault-secret-v1:"));
  return {
    recordCount: records.length,
    deviceStoreKeyPath: db.transaction("devices", "readonly").objectStore("devices").keyPath,
    hasLegacyCryptoKeyStore: db.objectStoreNames.contains("cryptoKeys"),
    hasChatStateStore: db.objectStoreNames.contains("chatState"),
    hasPushPreviewKeyStore: db.objectStoreNames.contains("pushPreviewKeys"),
    hasPushPreviewTrustStore: db.objectStoreNames.contains("pushPreviewTrust"),
    pushPreviewRecordCount: previewRecords.length,
    pushPreviewMatchesDevice: previewRecord.deviceId === record.deviceId
      && previewRecord.publicKey === window.__yachatE2EE?.pushPreviewPublic,
    pushPreviewHasPrivateKey: typeof previewRecord.privateJwk?.d === "string",
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
assert.equal(stored.hasPushPreviewKeyStore, true);
assert.equal(stored.hasPushPreviewTrustStore, true);
assert.equal(stored.pushPreviewRecordCount, 1);
assert.equal(stored.pushPreviewMatchesDevice, true);
assert.equal(stored.pushPreviewHasPrivateKey, true, "the service worker needs its dedicated device-bound preview key");
assert.equal(stored.hasVault, true, "message-history private JWK material must remain inside the encrypted vault");
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
assert.equal(capturedMessageBodies[4].e2ee.version, 2, "text-only messages remain readable by phase 2 devices");

attachmentEncryptionReady = false;
const phase2Fallback = await send({ text: "Совместимое вложение", attachments: [attachment] });
assert.equal(phase2Fallback.message.e2eeVerified, true);
assert.equal(phase2Fallback.message.attachments[0].dataUrl, attachment.dataUrl);
assert.equal(capturedMessageBodies[5].e2ee.version, 2);
assert.equal(capturedMessageBodies[5].e2ee.attachmentMode, "plaintext");
assert.equal(capturedMessageBodies[5].attachments[0].dataUrl, attachment.dataUrl);

assert.equal(heartbeatRequests >= 0, true);
await browser.close();
console.log(`E2EE phase 4 ${browserName} test passed: real encrypted notification text, attachments, fallback, reload and tamper rejection.`);

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

await page.route("**/api/e2ee/device/register", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  assert.equal(body.algorithm, "yachat-x3dh-v1");
  assert.match(body.deviceId, /^[A-Za-z0-9._:-]{8,128}$/);
  assert.equal(typeof body.identityDhPublic, "string");
  assert.equal(typeof body.identitySignPublic, "string");
  assert.equal(Array.isArray(body.oneTimePreKeys), true);
  assert.ok(body.oneTimePreKeys.length >= 24);
  registeredBundle = body;
  firstIdentityKey ||= body.identityDhPublic;
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      deviceId: body.deviceId,
      algorithm: body.algorithm,
      availableOneTimePreKeys: body.oneTimePreKeys.length,
      needsOneTimePreKeys: false,
      rolloutPhase: "shadow"
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
      rolloutPhase: "shadow",
      bundles: [{
        deviceId: registeredBundle.deviceId,
        userId: "account-test",
        algorithm: registeredBundle.algorithm,
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
  assert.equal(body.e2ee?.mode, "shadow");
  assert.equal(body.e2ee?.version, 1);
  assert.ok(body.e2ee?.ciphertext);
  assert.ok(Array.isArray(body.e2ee?.envelopes));
  assert.equal(body.e2ee.envelopes.length, 1);
  assert.equal(JSON.stringify(body).includes("identityDhPrivate"), false);
  assert.equal(JSON.stringify(body).includes("identitySignPrivate"), false);

  const e2ee = structuredClone(body.e2ee);
  if (messageRequests === 2) {
    const first = e2ee.ciphertext[0];
    e2ee.ciphertext = `${first === "A" ? "B" : "A"}${e2ee.ciphertext.slice(1)}`;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      inserted: true,
      message: {
        id: body.clientMessageId,
        chatId: body.chatId,
        author: "user",
        authorId: "account-test",
        text: body.text,
        formattedHtml: body.formattedHtml || "",
        replyToMessageId: body.replyToMessageId || null,
        attachments: body.attachments || [],
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
    await page.waitForFunction(() => window.__yachatE2EE?.ready === true, null, { timeout: 30_000 });
  } catch (error) {
    const diagnostics = await browserDiagnostics();
    throw new Error(`${error?.message || error}\nE2EE diagnostics: ${JSON.stringify(diagnostics)}`);
  }
}

async function send(text) {
  return page.evaluate(async (messageText) => {
    const id = crypto.randomUUID();
    const response = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: "private-test-chat",
        clientMessageId: id,
        text: messageText,
        formattedHtml: "",
        attachments: []
      })
    });
    return response.json();
  }, text);
}

await page.goto(`${baseUrl}/e2ee-browser-fixture.html`, { waitUntil: "load" });
await waitReady();

const first = await send("Сквозной тест");
assert.equal(first.message.text, "Сквозной тест");
assert.equal(first.message.e2eeVerified, true, "untampered shadow ciphertext must verify");
assert.equal(first.message.e2ee.mode, "shadow");

const tampered = await send("Проверка подмены");
assert.equal(tampered.message.e2eeVerified, false, "tampered ciphertext must fail verification");
await page.waitForFunction(() => window.__yachatE2EE?.verificationFailures >= 1);

const stored = await page.evaluate(async () => {
  const request = indexedDB.open("yachat-e2ee-v1", 1);
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
  const record = records[0];
  return {
    count: records.length,
    hasIdentityPrivateKey: record?.identityDhPrivate instanceof CryptoKey,
    hasSigningPrivateKey: record?.identitySignPrivate instanceof CryptoKey,
    identityPrivateExtractable: record?.identityDhPrivate?.extractable,
    signingPrivateExtractable: record?.identitySignPrivate?.extractable
  };
});
assert.equal(stored.count, 1);
assert.equal(stored.hasIdentityPrivateKey, true);
assert.equal(stored.hasSigningPrivateKey, true);
assert.equal(stored.identityPrivateExtractable, false);
assert.equal(stored.signingPrivateExtractable, false);

registeredBundle = null;
await page.reload({ waitUntil: "load" });
await waitReady();
assert.ok(registeredBundle, "device must re-register after reload");
assert.equal(registeredBundle.identityDhPublic, firstIdentityKey, "device identity must persist across reloads");

await browser.close();
console.log(`E2EE ${browserName} test passed: IndexedDB keys, shadow round trip, persistence and tamper rejection.`);

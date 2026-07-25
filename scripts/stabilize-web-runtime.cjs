const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const version = "99";

function replaceRequired(content, before, after, label) {
  if (!content.includes(before)) throw new Error(`Unable to patch ${label}.`);
  return content.replace(before, after);
}

async function patchDatabaseResilience() {
  const resiliencePath = path.join(publicDir, "assets", "db-resilience.js");
  let resilience = await fs.readFile(resiliencePath, "utf8");
  resilience = replaceRequired(
    resilience,
    "const WRITE_TIMEOUT_MS = 9000;",
    "const WRITE_TIMEOUT_MS = 20000;",
    "foreground write timeout"
  );
  resilience = replaceRequired(
    resilience,
    "    if (Date.now() < circuitOpenUntil) return unavailableResponse();\n\n    try {",
    "    // A slow background read must never block a message send locally.\n    // Always let the server receive foreground writes and report the real result.\n    try {",
    "write-through circuit breaker"
  );
  if (resilience.includes("Date.now() < circuitOpenUntil) return unavailableResponse()")) {
    throw new Error("Foreground writes are still blocked by the database circuit breaker.");
  }
  await fs.writeFile(resiliencePath, resilience, "utf8");
  await execFileAsync(process.execPath, ["--check", resiliencePath]);
}

async function patchE2EERuntime() {
  const runtimePath = path.join(publicDir, "assets", "e2ee-runtime.js");
  let runtime = await fs.readFile(runtimePath, "utf8");

  runtime = replaceRequired(
    runtime,
    `  const DEVICE_ID_KEY = "yachat-e2ee-device-id-v1";
  const PUSH_DEVICE_ID_KEY = "yachat-push-installation-id-v1";
  const DB_NAME = "yachat-e2ee-v1";
  const DB_VERSION = 1;`,
    `  const DEVICE_ID_KEY_PREFIX = "yachat-e2ee-device-id-v1:";
  const VAULT_SECRET_KEY_PREFIX = "yachat-e2ee-vault-secret-v1:";
  const DB_NAME = "yachat-e2ee-v1";
  const DB_VERSION = 4;`,
    "account-scoped E2EE storage constants"
  );

  runtime = replaceRequired(
    runtime,
    `  function deviceId() {
    const existing = safeStorageGet(DEVICE_ID_KEY).trim() || safeStorageGet(PUSH_DEVICE_ID_KEY).trim();
    if (/^[A-Za-z0-9._:-]{8,128}$/.test(existing)) {
      safeStorageSet(DEVICE_ID_KEY, existing);
      if (!safeStorageGet(PUSH_DEVICE_ID_KEY)) safeStorageSet(PUSH_DEVICE_ID_KEY, existing);
      return existing;
    }
    const created = randomId("device");
    safeStorageSet(DEVICE_ID_KEY, created);
    if (!safeStorageGet(PUSH_DEVICE_ID_KEY)) safeStorageSet(PUSH_DEVICE_ID_KEY, created);
    return created;
  }`,
    `  function deviceId(accountId) {
    const accountScope = String(accountId || "").trim();
    if (!accountScope) throw new Error("E2EE device identity requires an account.");
    const storageKey = \`\${DEVICE_ID_KEY_PREFIX}\${accountScope}\`;
    const existing = safeStorageGet(storageKey).trim();
    if (/^[A-Za-z0-9._:-]{8,128}$/.test(existing)) return existing;
    const created = randomId("e2ee-device");
    safeStorageSet(storageKey, created);
    return created;
  }

  function vaultSecretBytes(accountId, currentDeviceId, create = true) {
    const storageKey = \`\${VAULT_SECRET_KEY_PREFIX}\${accountId}:\${currentDeviceId}\`;
    const existing = safeStorageGet(storageKey).trim();
    if (existing) return base64UrlToBytes(existing);
    if (!create) throw new Error("The local E2EE key vault is unavailable.");
    const created = randomBytes(32);
    if (!safeStorageSet(storageKey, bytesToBase64Url(created))) {
      throw new Error("The browser cannot persist the local E2EE vault secret.");
    }
    return created;
  }`,
    "per-account device and vault identities"
  );

  runtime = replaceRequired(
    runtime,
    `  async function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("devices")) db.createObjectStore("devices", { keyPath: "key" });
        if (!db.objectStoreNames.contains("trust")) db.createObjectStore("trust", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Unable to open the E2EE key store."));
    });
    return databasePromise;
  }

  async function storeGet(storeName, key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Unable to read the E2EE key store."));
    });
  }

  async function storePut(storeName, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value);
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error || new Error("Unable to write the E2EE key store."));
      transaction.onabort = () => reject(transaction.error || new Error("E2EE key store transaction aborted."));
    });
  }`,
    `  async function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        // Earlier preview builds experimented with direct CryptoKey storage.
        // Safari does not persist X25519/Ed25519 keys reliably, so Phase 1
        // uses an AES-GCM encrypted JWK vault instead.
        if (db.objectStoreNames.contains("devices")) db.deleteObjectStore("devices");
        if (db.objectStoreNames.contains("cryptoKeys")) db.deleteObjectStore("cryptoKeys");
        db.createObjectStore("devices");
        if (!db.objectStoreNames.contains("trust")) db.createObjectStore("trust", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Unable to open the E2EE key store."));
    });
    return databasePromise;
  }

  async function rawStoreGet(storeName, key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error || new Error("Unable to read the E2EE key store."));
    });
  }

  async function rawStorePut(storeName, key, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      if (storeName === "devices") store.put(value, key);
      else store.put(value);
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error || new Error("Unable to write the E2EE key store."));
      transaction.onabort = () => reject(transaction.error || new Error("E2EE key store transaction aborted."));
    });
  }

  async function vaultKey(accountId, currentDeviceId) {
    return crypto.subtle.importKey(
      "raw",
      vaultSecretBytes(accountId, currentDeviceId),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function importPrivateJwk(jwk, name, usages) {
    if (!jwk || typeof jwk !== "object" || !jwk.d) {
      throw new Error("An E2EE private key is missing from the local vault.");
    }
    const key = await crypto.subtle.importKey("jwk", jwk, { name }, false, usages);
    if (key.extractable !== false) throw new Error("An E2EE private key became exportable.");
    return key;
  }

  async function encryptPrivateVault(record) {
    const material = {
      identityDhPrivateJwk: record.identityDhPrivateJwk,
      identitySignPrivateJwk: record.identitySignPrivateJwk,
      signedPreKeys: (record.signedPreKeys || []).map((item) => ({ id: item.id, privateJwk: item.privateJwk })),
      oneTimePreKeys: (record.oneTimePreKeys || []).map((item) => ({ id: item.id, privateJwk: item.privateJwk }))
    };
    const iv = randomBytes(12);
    const aad = encoder.encode(\`\${ALGORITHM}|vault|\${record.key}\`);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      await vaultKey(record.accountId, record.deviceId),
      encoder.encode(JSON.stringify(material))
    );
    return { version: 1, iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(ciphertext) };
  }

  async function hydrateDeviceRecord(metadata) {
    if (!metadata) return null;
    const vault = metadata.privateVault;
    if (!vault?.iv || !vault?.ciphertext) throw new Error("The local E2EE private-key vault is missing.");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(vault.iv),
        additionalData: encoder.encode(\`\${ALGORITHM}|vault|\${metadata.key}\`)
      },
      await vaultKey(metadata.accountId, metadata.deviceId),
      base64UrlToBytes(vault.ciphertext)
    );
    const material = JSON.parse(decoder.decode(plaintext));
    const signedPrivate = new Map((material.signedPreKeys || []).map((item) => [item.id, item.privateJwk]));
    const oneTimePrivate = new Map((material.oneTimePreKeys || []).map((item) => [item.id, item.privateJwk]));
    return {
      ...metadata,
      identityDhPrivateJwk: material.identityDhPrivateJwk,
      identitySignPrivateJwk: material.identitySignPrivateJwk,
      identityDhPrivate: await importPrivateJwk(material.identityDhPrivateJwk, "X25519", ["deriveBits"]),
      identitySignPrivate: await importPrivateJwk(material.identitySignPrivateJwk, "Ed25519", ["sign"]),
      signedPreKeys: await Promise.all((metadata.signedPreKeys || []).map(async (item) => ({
        ...item,
        privateJwk: signedPrivate.get(item.id),
        privateKey: await importPrivateJwk(signedPrivate.get(item.id), "X25519", ["deriveBits"])
      }))),
      oneTimePreKeys: await Promise.all((metadata.oneTimePreKeys || []).map(async (item) => ({
        ...item,
        privateJwk: oneTimePrivate.get(item.id),
        privateKey: await importPrivateJwk(oneTimePrivate.get(item.id), "X25519", ["deriveBits"])
      })))
    };
  }

  async function storeGet(storeName, key) {
    const value = await rawStoreGet(storeName, key);
    return storeName === "devices" ? hydrateDeviceRecord(value) : value;
  }

  async function storePut(storeName, value) {
    if (storeName !== "devices") return rawStorePut(storeName, value?.key || "", value);
    const metadata = {
      ...value,
      privateVault: await encryptPrivateVault(value),
      signedPreKeys: (value.signedPreKeys || []).map(({ privateKey, privateJwk, ...item }) => item),
      oneTimePreKeys: (value.oneTimePreKeys || []).map(({ privateKey, privateJwk, ...item }) => item)
    };
    delete metadata.identityDhPrivate;
    delete metadata.identitySignPrivate;
    delete metadata.identityDhPrivateJwk;
    delete metadata.identitySignPrivateJwk;
    return rawStorePut("devices", value.key, metadata);
  }`,
    "Safari-compatible encrypted private-key vault"
  );

  runtime = replaceRequired(
    runtime,
    `    return { publicKey: bytesToBase64Url(publicRaw), privateKey };`,
    `    return { publicKey: bytesToBase64Url(publicRaw), privateKey, privateJwk };`,
    "retain private JWK only inside the encrypted local vault"
  );
  runtime = replaceRequired(
    runtime,
    `      privateKey: pair.privateKey,
      signature: bytesToBase64Url(signature),`,
    `      privateKey: pair.privateKey,
      privateJwk: pair.privateJwk,
      signature: bytesToBase64Url(signature),`,
    "signed prekey private JWK"
  );
  runtime = replaceRequired(
    runtime,
    `      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      createdAt: Date.now()`,
    `      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      privateJwk: pair.privateJwk,
      createdAt: Date.now()`,
    "one-time prekey private JWK"
  );
  runtime = replaceRequired(
    runtime,
    `      identityDhPublic: identityDh.publicKey,
      identityDhPrivate: identityDh.privateKey,
      identitySignPublic: identitySign.publicKey,
      identitySignPrivate: identitySign.privateKey,`,
    `      identityDhPublic: identityDh.publicKey,
      identityDhPrivate: identityDh.privateKey,
      identityDhPrivateJwk: identityDh.privateJwk,
      identitySignPublic: identitySign.publicKey,
      identitySignPrivate: identitySign.privateKey,
      identitySignPrivateJwk: identitySign.privateJwk,`,
    "identity private JWK vault material"
  );
  runtime = replaceRequired(
    runtime,
    "      const currentDeviceId = deviceId();",
    "      const currentDeviceId = deviceId(accountId);",
    "account-scoped device id call"
  );

  if (
    runtime.includes("PUSH_DEVICE_ID_KEY")
    || runtime.includes("const currentDeviceId = deviceId();")
    || runtime.includes('createObjectStore("cryptoKeys")')
    || !runtime.includes("privateVault: await encryptPrivateVault(value)")
  ) {
    throw new Error("E2EE runtime still contains unsafe device or Safari key persistence logic.");
  }
  await fs.writeFile(runtimePath, runtime, "utf8");
}

async function patchMessengerE2EEPayloads() {
  const messengerPath = path.join(root, "api", "messenger_fast.py");
  let messenger = await fs.readFile(messengerPath, "utf8");
  if (!messenger.includes("from server.e2ee import attach_e2ee_payload")) {
    messenger = replaceRequired(
      messenger,
      "from psycopg.rows import dict_row\n\nfrom api.index import (",
      "from psycopg.rows import dict_row\n\nfrom server.e2ee import attach_e2ee_payload\n\nfrom api.index import (",
      "E2EE message payload import"
    );
  }
  messenger = replaceRequired(
    messenger,
    "            return [message_payload(row, user_id, recipient_read_times) for row in rows]",
    "            return [attach_e2ee_payload(message_payload(row, user_id, recipient_read_times), row) for row in rows]",
    "E2EE message payload projection"
  );
  if (!messenger.includes("attach_e2ee_payload(message_payload")) {
    throw new Error("Messenger responses do not include E2EE payloads.");
  }
  await fs.writeFile(messengerPath, messenger, "utf8");
}

async function main() {
  await patchDatabaseResilience();
  await patchE2EERuntime();
  await patchMessengerE2EEPayloads();
  await execFileAsync(process.execPath, [path.join(root, "scripts", "test-e2ee-crypto.mjs")]);

  const webPath = path.join(publicDir, "web.html");
  let html = await fs.readFile(webPath, "utf8");
  const styleTag = `    <link rel="stylesheet" href="/assets/pawlight-fixes.css?v=${version}" />`;
  const e2eeTag = `    <script src="/assets/e2ee-runtime.js?v=${version}"></script>`;
  const pawlightTag = `    <script src="/assets/pawlight-fixes.js?v=${version}"></script>`;
  if (!html.includes(styleTag)) {
    const marker = '<meta name="referrer" content="origin" />';
    if (!html.includes(marker)) throw new Error("Unable to place Pawlight styles.");
    html = html.replace(marker, `${styleTag}\n    ${marker}`);
  }
  if (!html.includes(e2eeTag)) html = html.replace("</body>", `${e2eeTag}\n  </body>`);
  if (!html.includes(pawlightTag)) html = html.replace("</body>", `${pawlightTag}\n  </body>`);
  if (html.indexOf(e2eeTag) > html.indexOf(pawlightTag)) {
    throw new Error("E2EE runtime must load before the final Pawlight decorator.");
  }
  if (html.includes("yachat-app.bundle.js") || html.includes("yachat-app.bundle.css")) {
    throw new Error("Unsafe consolidated frontend bundle is still enabled.");
  }
  await Promise.all([
    "e2ee-runtime.js",
    "pawlight-fixes.js"
  ].map((name) => execFileAsync(process.execPath, ["--check", path.join(publicDir, "assets", name)])));
  await fs.writeFile(webPath, html, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

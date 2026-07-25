const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const version = "98";

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
    '  const DEVICE_ID_KEY = "yachat-e2ee-device-id-v1";\n  const PUSH_DEVICE_ID_KEY = "yachat-push-installation-id-v1";',
    '  const DEVICE_ID_KEY_PREFIX = "yachat-e2ee-device-id-v1:";',
    "separate E2EE and push device identities"
  );

  runtime = replaceRequired(
    runtime,
    '  const DB_VERSION = 1;',
    '  const DB_VERSION = 3;',
    "split CryptoKey database version"
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
  }`,
    "per-account E2EE device id"
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
        // WebKit can persist individual CryptoKey values, but is unreliable
        // when records with keyPath/indexes also contain nested CryptoKeys.
        if (db.objectStoreNames.contains("devices")) db.deleteObjectStore("devices");
        if (db.objectStoreNames.contains("cryptoKeys")) db.deleteObjectStore("cryptoKeys");
        db.createObjectStore("devices");
        db.createObjectStore("cryptoKeys");
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

  async function rawStoreGetMany(storeName, keys) {
    if (!keys.length) return [];
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const values = new Array(keys.length);
      keys.forEach((key, index) => {
        const request = store.get(key);
        request.onsuccess = () => { values[index] = request.result ?? null; };
        request.onerror = () => reject(request.error || new Error("Unable to read E2EE CryptoKeys."));
      });
      transaction.oncomplete = () => resolve(values);
      transaction.onerror = () => reject(transaction.error || new Error("Unable to read E2EE CryptoKeys."));
      transaction.onabort = () => reject(transaction.error || new Error("E2EE CryptoKey read aborted."));
    });
  }

  async function hydrateDeviceRecord(metadata) {
    if (!metadata) return null;
    const refs = [
      metadata.identityDhPrivateRef,
      metadata.identitySignPrivateRef,
      ...(metadata.signedPreKeys || []).map((item) => item.privateKeyRef),
      ...(metadata.oneTimePreKeys || []).map((item) => item.privateKeyRef)
    ];
    const keys = await rawStoreGetMany("cryptoKeys", refs);
    if (keys.some((key) => !(key instanceof CryptoKey))) {
      throw new Error("One or more persisted E2EE private keys are unavailable.");
    }
    let offset = 0;
    const identityDhPrivate = keys[offset++];
    const identitySignPrivate = keys[offset++];
    const signedPreKeys = (metadata.signedPreKeys || []).map((item) => ({
      ...item,
      privateKey: keys[offset++]
    }));
    const oneTimePreKeys = (metadata.oneTimePreKeys || []).map((item) => ({
      ...item,
      privateKey: keys[offset++]
    }));
    return {
      ...metadata,
      identityDhPrivate,
      identitySignPrivate,
      signedPreKeys,
      oneTimePreKeys
    };
  }

  async function storeGet(storeName, key) {
    const value = await rawStoreGet(storeName, key);
    return storeName === "devices" ? hydrateDeviceRecord(value) : value;
  }

  async function storePut(storeName, value) {
    if (storeName !== "devices") {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put(value);
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = () => reject(transaction.error || new Error("Unable to write the E2EE key store."));
        transaction.onabort = () => reject(transaction.error || new Error("E2EE key store transaction aborted."));
      });
    }

    const identityDhPrivateRef = \`\${value.key}:identity-dh\`;
    const identitySignPrivateRef = \`\${value.key}:identity-sign\`;
    const signedPreKeys = (value.signedPreKeys || []).map((item) => {
      const privateKeyRef = \`\${value.key}:signed:\${item.id}\`;
      return { ...item, privateKeyRef };
    });
    const oneTimePreKeys = (value.oneTimePreKeys || []).map((item) => {
      const privateKeyRef = \`\${value.key}:one-time:\${item.id}\`;
      return { ...item, privateKeyRef };
    });
    const metadata = {
      ...value,
      identityDhPrivateRef,
      identitySignPrivateRef,
      signedPreKeys: signedPreKeys.map(({ privateKey, ...item }) => item),
      oneTimePreKeys: oneTimePreKeys.map(({ privateKey, ...item }) => item)
    };
    delete metadata.identityDhPrivate;
    delete metadata.identitySignPrivate;

    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["devices", "cryptoKeys"], "readwrite");
      const deviceStore = transaction.objectStore("devices");
      const keyStore = transaction.objectStore("cryptoKeys");
      keyStore.put(value.identityDhPrivate, identityDhPrivateRef);
      keyStore.put(value.identitySignPrivate, identitySignPrivateRef);
      signedPreKeys.forEach((item, index) => keyStore.put(value.signedPreKeys[index].privateKey, item.privateKeyRef));
      oneTimePreKeys.forEach((item, index) => keyStore.put(value.oneTimePreKeys[index].privateKey, item.privateKeyRef));
      deviceStore.put(metadata, value.key);
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error || new Error("Unable to persist E2EE private keys."));
      transaction.onabort = () => reject(transaction.error || new Error("E2EE private-key transaction aborted."));
    });
  }`,
    "split WebKit CryptoKey persistence"
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
    || runtime.includes('createObjectStore("devices", { keyPath: "key" })')
  ) {
    throw new Error("E2EE runtime still contains an unsafe identity or nested CryptoKey store.");
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

  if (!html.includes(e2eeTag)) {
    if (!html.includes("</body>")) throw new Error("Unable to place E2EE runtime.");
    html = html.replace("</body>", `${e2eeTag}\n  </body>`);
  }

  if (!html.includes(pawlightTag)) {
    if (!html.includes("</body>")) throw new Error("Unable to place Pawlight runtime.");
    html = html.replace("</body>", `${pawlightTag}\n  </body>`);
  }

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

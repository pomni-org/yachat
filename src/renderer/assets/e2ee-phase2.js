(() => {
  "use strict";

  if (window.__yachatE2EEPhase2Installed) return;
  window.__yachatE2EEPhase2Installed = true;

  const ALGORITHM = "yachat-x3dh-v1";
  const PROTOCOL_VERSION = 5;
  const CAPABILITIES = [
    "shadow-v1",
    "server-blind-text-v1",
    "attachment-integrity-v1",
    "encrypted-attachments-v1",
    "encrypted-push-preview-v1",
    "mandatory-e2ee-v1",
    "signed-messages-v1",
    "padded-content-v1",
    "sealed-push-descriptor-v1",
    "encrypted-digital-id-v1"
  ];
  const PHASE5_CAPABILITIES = [
    "server-blind-text-v1",
    "encrypted-attachments-v1",
    "encrypted-push-preview-v1",
    "mandatory-e2ee-v1",
    "signed-messages-v1",
    "padded-content-v1",
    "sealed-push-descriptor-v1",
    "encrypted-digital-id-v1"
  ];
  const ENCRYPTED_ATTACHMENT_MIME = "application/vnd.yachat.e2ee";
  const MAX_ATTACHMENT_DATA_URL_CHARS = 9000000;
  const AUTH_TOKEN_KEY = "yachat-http-auth-token";
  const DEVICE_ID_KEY_PREFIX = "yachat-e2ee-device-id-v1:";
  const VAULT_SECRET_KEY_PREFIX = "yachat-e2ee-vault-secret-v1:";
  const DB_NAME = "yachat-e2ee-v1";
  const DB_VERSION = 7;
  const PUSH_PREVIEW_PLAINTEXT_BYTES = 1024;
  const CONTENT_PADDING_BUCKETS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
  const DIGITAL_ID_PLAINTEXT_BYTES = 256;
  const SIGNED_PREKEY_ROTATION_MS = 14 * 24 * 60 * 60 * 1000;
  const HEARTBEAT_MS = 15 * 60 * 1000;
  const PREKEY_TARGET = 32;
  const MAX_LOCAL_PREKEYS = 220;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const nativeFetch = window.fetch.bind(window);

  let databasePromise = null;
  let initializationPromise = null;
  let activeAccountId = "";
  let activeRecord = null;
  let activePushPreview = null;
  let lastInitializationAttempt = 0;
  let lastHeartbeatAt = 0;
  let status = {
    supported: false,
    ready: false,
    phase: "initializing",
    protocolVersion: PROTOCOL_VERSION,
    deviceId: "",
    accountId: "",
    pushPreviewPublic: "",
    verifiedMessages: 0,
    verificationFailures: 0,
    encryptedMessages: 0,
    shadowMessages: 0,
    lastError: ""
  };

  function publishStatus(patch = {}) {
    status = { ...status, ...patch };
    window.__yachatE2EE = Object.freeze({ ...status });
    window.dispatchEvent(new CustomEvent("yachat:e2ee-status", { detail: { ...status } }));
  }

  function e2eeError(message, fatal = false) {
    const error = new Error(message);
    error.e2eeFatal = fatal;
    return error;
  }

  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function randomId(prefix) {
    const value = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${value}`;
  }

  function bytesToBase64Url(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";
    const chunk = 0x8000;
    for (let offset = 0; offset < view.length; offset += chunk) {
      binary += String.fromCharCode(...view.subarray(offset, offset + chunk));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(value) {
    const source = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = source + "=".repeat((4 - source.length % 4) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function bytesToBase64(bytes) {
    const value = bytesToBase64Url(bytes).replace(/-/g, "+").replace(/_/g, "/");
    return value + "=".repeat((4 - value.length % 4) % 4);
  }

  function base64ToBytes(value) {
    return base64UrlToBytes(String(value || "").replace(/\+/g, "-").replace(/\//g, "_"));
  }

  function concatBytes(parts) {
    const arrays = parts.map((part) => part instanceof Uint8Array ? part : new Uint8Array(part));
    const output = new Uint8Array(arrays.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of arrays) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  function currentAccountId() {
    try {
      if (typeof state !== "undefined" && state?.account?.id) return String(state.account.id);
    } catch {
      // The app's global lexical state may not exist before bootstrap.
    }
    return String(window.__yachatAccount?.id || "");
  }

  function authToken() {
    return safeStorageGet(AUTH_TOKEN_KEY).trim();
  }

  function deviceId(accountId) {
    const accountScope = String(accountId || "").trim();
    if (!accountScope) throw e2eeError("E2EE device identity requires an account.");
    const storageKey = `${DEVICE_ID_KEY_PREFIX}${accountScope}`;
    const existing = safeStorageGet(storageKey).trim();
    if (/^[A-Za-z0-9._:-]{8,128}$/.test(existing)) return existing;
    const created = randomId("e2ee-device");
    if (!safeStorageSet(storageKey, created)) throw e2eeError("The browser cannot persist the E2EE device id.");
    return created;
  }

  function vaultSecretBytes(accountId, currentDeviceId, create = true) {
    const storageKey = `${VAULT_SECRET_KEY_PREFIX}${accountId}:${currentDeviceId}`;
    const existing = safeStorageGet(storageKey).trim();
    if (existing) return base64UrlToBytes(existing);
    if (!create) throw e2eeError("The local E2EE key vault is unavailable.", true);
    const created = randomBytes(32);
    if (!safeStorageSet(storageKey, bytesToBase64Url(created))) {
      throw e2eeError("The browser cannot persist the local E2EE vault secret.", true);
    }
    return created;
  }

  async function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("devices")) db.createObjectStore("devices");
        if (!db.objectStoreNames.contains("trust")) db.createObjectStore("trust", { keyPath: "key" });
        if (!db.objectStoreNames.contains("chatState")) db.createObjectStore("chatState", { keyPath: "key" });
        if (!db.objectStoreNames.contains("pushPreviewKeys")) db.createObjectStore("pushPreviewKeys", { keyPath: "deviceId" });
        if (!db.objectStoreNames.contains("pushPreviewTrust")) db.createObjectStore("pushPreviewTrust", { keyPath: "key" });
        if (!db.objectStoreNames.contains("messageKeys")) db.createObjectStore("messageKeys", { keyPath: "key" });
        if (db.objectStoreNames.contains("cryptoKeys")) db.deleteObjectStore("cryptoKeys");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || e2eeError("Unable to open the E2EE key store."));
    });
    return databasePromise;
  }

  async function rawStoreGet(storeName, key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error || e2eeError("Unable to read the E2EE key store."));
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
      transaction.onerror = () => reject(transaction.error || e2eeError("Unable to write the E2EE key store."));
      transaction.onabort = () => reject(transaction.error || e2eeError("E2EE key-store transaction aborted."));
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

  function messageKeyCacheId(record, messageId) {
    return `${record.accountId}:${record.deviceId}:${messageId}`;
  }

  async function cachedMessageKey(record, messageId) {
    const cacheId = messageKeyCacheId(record, messageId);
    const stored = await rawStoreGet("messageKeys", cacheId);
    if (!stored?.iv || !stored?.ciphertext) return null;
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(stored.iv),
        additionalData: encoder.encode(`${ALGORITHM}|message-key-cache|${cacheId}`)
      },
      await vaultKey(record.accountId, record.deviceId),
      base64UrlToBytes(stored.ciphertext)
    );
    const bytes = new Uint8Array(plaintext);
    return bytes.byteLength === 32 ? bytes : null;
  }

  async function cacheMessageKey(record, messageId, contentKeyBytes) {
    const cacheId = messageKeyCacheId(record, messageId);
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(`${ALGORITHM}|message-key-cache|${cacheId}`)
      },
      await vaultKey(record.accountId, record.deviceId),
      contentKeyBytes
    );
    await rawStorePut("messageKeys", cacheId, {
      key: cacheId,
      iv: bytesToBase64Url(iv),
      ciphertext: bytesToBase64Url(ciphertext),
      createdAt: Date.now()
    });
  }

  async function importPrivateJwk(jwk, name, usages) {
    if (!jwk || typeof jwk !== "object" || !jwk.d) throw e2eeError("A private key is missing from the local E2EE vault.", true);
    const key = await crypto.subtle.importKey("jwk", jwk, { name }, false, usages);
    if (key.extractable !== false) throw e2eeError("A private E2EE key became exportable.", true);
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
    const aad = encoder.encode(`${ALGORITHM}|vault|${record.key}`);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      await vaultKey(record.accountId, record.deviceId),
      encoder.encode(JSON.stringify(material))
    );
    return { version: 2, iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(ciphertext) };
  }

  async function hydrateDeviceRecord(metadata) {
    if (!metadata) return null;
    const vault = metadata.privateVault;
    if (!vault?.iv || !vault?.ciphertext) throw e2eeError("The local E2EE private-key vault is missing.", true);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(vault.iv),
        additionalData: encoder.encode(`${ALGORITHM}|vault|${metadata.key}`)
      },
      await vaultKey(metadata.accountId, metadata.deviceId),
      base64UrlToBytes(vault.ciphertext)
    );
    const material = JSON.parse(decoder.decode(plaintext));
    const signedPrivate = new Map((material.signedPreKeys || []).map((item) => [item.id, item.privateJwk]));
    const oneTimePrivate = new Map((material.oneTimePreKeys || []).map((item) => [item.id, item.privateJwk]));
    return {
      ...metadata,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: CAPABILITIES,
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
      protocolVersion: PROTOCOL_VERSION,
      capabilities: CAPABILITIES,
      privateVault: await encryptPrivateVault(value),
      signedPreKeys: (value.signedPreKeys || []).map(({ privateKey, privateJwk, ...item }) => item),
      oneTimePreKeys: (value.oneTimePreKeys || []).map(({ privateKey, privateJwk, ...item }) => item)
    };
    delete metadata.identityDhPrivate;
    delete metadata.identitySignPrivate;
    delete metadata.identityDhPrivateJwk;
    delete metadata.identitySignPrivateJwk;
    return rawStorePut("devices", value.key, metadata);
  }

  async function hardenedKeyPair(name, publicUsages, privateUsages) {
    const pair = await crypto.subtle.generateKey({ name }, true, [...new Set([...publicUsages, ...privateUsages])]);
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name }, false, privateUsages);
    return { publicKey: bytesToBase64Url(publicRaw), privateKey, privateJwk };
  }

  function pushPreviewKeyAttestation(currentDeviceId, publicKey) {
    return `${ALGORITHM}|push-preview-key|v1|${currentDeviceId}|${publicKey}`;
  }

  function identityDhKeyAttestation(currentDeviceId, publicKey) {
    return `${ALGORITHM}|identity-dh-key|v1|${currentDeviceId}|${publicKey}`;
  }

  function pushPreviewPublicFromJwk(jwk) {
    try {
      if (!jwk?.x || !jwk?.y) return "";
      return bytesToBase64Url(concatBytes([
        new Uint8Array([4]),
        base64UrlToBytes(jwk.x),
        base64UrlToBytes(jwk.y)
      ]));
    } catch {
      return "";
    }
  }

  async function ensurePushPreviewKey(record) {
    let stored = await storeGet("pushPreviewKeys", record.deviceId);
    const storedPrivatePublic = pushPreviewPublicFromJwk(stored?.privateJwk);
    if (
      !stored
      || stored.version !== 1
      || stored.deviceId !== record.deviceId
      || typeof stored.publicKey !== "string"
      || !stored.privateJwk?.d
      || stored.privateJwk?.kty !== "EC"
      || stored.privateJwk?.crv !== "P-256"
      || storedPrivatePublic !== stored.publicKey
    ) {
      const pair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"]
      );
      stored = {
        version: 1,
        deviceId: record.deviceId,
        publicKey: bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
        privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
        createdAt: Date.now()
      };
      await rawStorePut("pushPreviewKeys", record.deviceId, stored);
    }
    const signature = new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      record.identitySignPrivate,
      encoder.encode(pushPreviewKeyAttestation(record.deviceId, stored.publicKey))
    ));
    return {
      version: 1,
      publicKey: stored.publicKey,
      signature: bytesToBase64Url(signature)
    };
  }

  async function createSignedPreKey(identitySignPrivate) {
    const pair = await hardenedKeyPair("X25519", [], ["deriveBits"]);
    const rawPublic = base64UrlToBytes(pair.publicKey);
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", identitySignPrivate, rawPublic));
    return {
      id: randomId("spk"),
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      privateJwk: pair.privateJwk,
      signature: bytesToBase64Url(signature),
      createdAt: Date.now()
    };
  }

  async function createOneTimePreKey() {
    const pair = await hardenedKeyPair("X25519", [], ["deriveBits"]);
    return {
      id: randomId("opk"),
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      privateJwk: pair.privateJwk,
      createdAt: Date.now()
    };
  }

  async function generatePreKeys(count) {
    const result = [];
    for (let index = 0; index < count; index += 1) result.push(await createOneTimePreKey());
    return result;
  }

  async function supportsRequiredCrypto() {
    if (!window.isSecureContext || !crypto?.subtle || !window.indexedDB) return false;
    try {
      const x = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
      const e = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
      const p = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"]
      );
      return Boolean(x?.privateKey && e?.privateKey && p?.privateKey);
    } catch {
      return false;
    }
  }

  async function createDeviceRecord(accountId, currentDeviceId) {
    const identityDh = await hardenedKeyPair("X25519", [], ["deriveBits"]);
    const identitySign = await hardenedKeyPair("Ed25519", ["verify"], ["sign"]);
    const identityDhSignature = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      identitySign.privateKey,
      encoder.encode(identityDhKeyAttestation(currentDeviceId, identityDh.publicKey))
    )));
    const signedPreKey = await createSignedPreKey(identitySign.privateKey);
    return {
      key: `${accountId}:${currentDeviceId}`,
      accountId,
      deviceId: currentDeviceId,
      algorithm: ALGORITHM,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: CAPABILITIES,
      identityDhPublic: identityDh.publicKey,
      identityDhSignature,
      identityDhPrivate: identityDh.privateKey,
      identityDhPrivateJwk: identityDh.privateJwk,
      identitySignPublic: identitySign.publicKey,
      identitySignPrivate: identitySign.privateKey,
      identitySignPrivateJwk: identitySign.privateJwk,
      signedPreKeys: [signedPreKey],
      oneTimePreKeys: await generatePreKeys(PREKEY_TARGET),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  async function refreshDeviceRecord(record) {
    const signed = Array.isArray(record.signedPreKeys) ? record.signedPreKeys : [];
    const latest = signed.at(-1);
    if (!latest || Date.now() - Number(latest.createdAt || 0) > SIGNED_PREKEY_ROTATION_MS) {
      signed.push(await createSignedPreKey(record.identitySignPrivate));
    }
    record.signedPreKeys = signed.slice(-4);
    record.oneTimePreKeys = Array.isArray(record.oneTimePreKeys) ? record.oneTimePreKeys : [];
    if (record.oneTimePreKeys.length < PREKEY_TARGET) {
      record.oneTimePreKeys.push(...await generatePreKeys(PREKEY_TARGET - record.oneTimePreKeys.length));
    }
    if (record.oneTimePreKeys.length > MAX_LOCAL_PREKEYS) {
      record.oneTimePreKeys = record.oneTimePreKeys.slice(-MAX_LOCAL_PREKEYS);
    }
    record.protocolVersion = PROTOCOL_VERSION;
    record.capabilities = CAPABILITIES;
    if (!record.identityDhSignature) {
      record.identityDhSignature = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign(
        "Ed25519",
        record.identitySignPrivate,
        encoder.encode(identityDhKeyAttestation(record.deviceId, record.identityDhPublic))
      )));
    }
    record.updatedAt = Date.now();
    await storePut("devices", record);
    return record;
  }

  async function apiJson(path, { method = "POST", body } = {}) {
    const token = authToken();
    if (!token) throw e2eeError("E2EE registration requires an authenticated account.");
    const response = await nativeFetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(activeRecord?.deviceId ? { "X-YaChat-E2EE-Device": activeRecord.deviceId } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok) throw e2eeError(String(payload.detail || `E2EE API failed (${response.status}).`), response.status === 409 || response.status === 426);
    return payload;
  }

  function registrationPayload(record, pushPreview) {
    const signed = record.signedPreKeys.at(-1);
    return {
      deviceId: record.deviceId,
      algorithm: ALGORITHM,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: CAPABILITIES,
      pushPreviewPublic: pushPreview.publicKey,
      pushPreviewSignature: pushPreview.signature,
      identityDhPublic: record.identityDhPublic,
      identityDhSignature: record.identityDhSignature,
      identitySignPublic: record.identitySignPublic,
      signedPreKey: {
        id: signed.id,
        publicKey: signed.publicKey,
        signature: signed.signature
      },
      oneTimePreKeys: record.oneTimePreKeys.slice(-100).map((prekey) => ({
        id: prekey.id,
        publicKey: prekey.publicKey
      }))
    };
  }

  async function registerDevice(record, pushPreview = activePushPreview) {
    const preview = pushPreview || await ensurePushPreviewKey(record);
    activePushPreview = preview;
    let result = await apiJson("/api/e2ee/device/register", { body: registrationPayload(record, preview) });
    if (result.needsOneTimePreKeys) {
      record.oneTimePreKeys.push(...await generatePreKeys(PREKEY_TARGET));
      if (record.oneTimePreKeys.length > MAX_LOCAL_PREKEYS) record.oneTimePreKeys = record.oneTimePreKeys.slice(-MAX_LOCAL_PREKEYS);
      await storePut("devices", record);
      result = await apiJson("/api/e2ee/device/register", { body: registrationPayload(record, preview) });
    }
    lastHeartbeatAt = Date.now();
    return result;
  }

  async function heartbeat(record) {
    const result = await apiJson("/api/e2ee/device/heartbeat", { body: { deviceId: record.deviceId } });
    lastHeartbeatAt = Date.now();
    if (result.needsOneTimePreKeys) {
      record.oneTimePreKeys.push(...await generatePreKeys(PREKEY_TARGET));
      if (record.oneTimePreKeys.length > MAX_LOCAL_PREKEYS) record.oneTimePreKeys = record.oneTimePreKeys.slice(-MAX_LOCAL_PREKEYS);
      await storePut("devices", record);
      await registerDevice(record, activePushPreview || await ensurePushPreviewKey(record));
    }
  }

  function digitalIdAad(accountId) {
    return `${ALGORITHM}|digital-id|v1|${accountId}`;
  }

  async function digitalIdEnvelopeDigest(envelopes) {
    const fields = [
      "deviceId",
      "recipientIdentityKey",
      "recipientIdentitySignPublic",
      "recipientIdentityDhSignature",
      "ephemeralKey",
      "salt",
      "iv",
      "ciphertext"
    ];
    const material = [...envelopes]
      .sort((left, right) => String(left?.deviceId || "").localeCompare(String(right?.deviceId || "")))
      .map((item) => fields.map((field) => String(item?.[field] || "")).join("|"))
      .join("\n");
    return digestText(material);
  }

  function digitalIdSignatureInput(vault) {
    return encoder.encode(
      `${ALGORITHM}|digital-id-signature|v1|${vault.aad}|${vault.iv}|`
      + `${vault.ciphertext}|${vault.plaintextDigest}|${vault.envelopeDigest}`
    );
  }

  function paddedDigitalId(rawDigitalId, accountId) {
    const encoded = encoder.encode(JSON.stringify({
      version: 1,
      accountId,
      digitalId: String(rawDigitalId || "")
    }));
    if (encoded.byteLength > DIGITAL_ID_PLAINTEXT_BYTES - 2) {
      throw e2eeError("The Digital ID payload is too large.", true);
    }
    const padded = randomBytes(DIGITAL_ID_PLAINTEXT_BYTES);
    padded[0] = (encoded.byteLength >>> 8) & 0xff;
    padded[1] = encoded.byteLength & 0xff;
    padded.set(encoded, 2);
    return padded;
  }

  function openPaddedDigitalId(padded, accountId) {
    if (padded.byteLength !== DIGITAL_ID_PLAINTEXT_BYTES) {
      throw e2eeError("The Digital ID vault size is invalid.", true);
    }
    const length = (padded[0] << 8) | padded[1];
    if (length <= 0 || length > padded.byteLength - 2) {
      throw e2eeError("The Digital ID vault payload is invalid.", true);
    }
    const decoded = JSON.parse(decoder.decode(padded.subarray(2, 2 + length)));
    if (
      Number(decoded.version || 0) !== 1
      || String(decoded.accountId || "") !== accountId
      || !String(decoded.digitalId || "")
    ) {
      throw e2eeError("The Digital ID vault context is invalid.", true);
    }
    return String(decoded.digitalId);
  }

  async function digitalIdEnvelopes(record, contentKeyBytes, bundles) {
    if (!Array.isArray(bundles) || !bundles.length) {
      throw e2eeError("No phase 5 device can receive the Digital ID vault.", true);
    }
    const envelopes = [];
    for (const bundle of bundles) {
      const recipientIdentityKey = String(bundle?.identityDhPublic || "");
      const recipientIdentitySignPublic = String(bundle?.identitySignPublic || "");
      const recipientIdentityDhSignature = String(bundle?.identityDhSignature || "");
      const recipientDeviceId = String(bundle?.deviceId || "");
      if (
        !recipientIdentityKey
        || !recipientIdentitySignPublic
        || !recipientIdentityDhSignature
        || !recipientDeviceId
        || !await verifyIdentityDhKey(bundle)
      ) {
        throw e2eeError("A Digital ID recipient bundle is invalid.", true);
      }
      const ephemeral = await hardenedKeyPair("X25519", [], ["deriveBits"]);
      const shared = await deriveX25519(ephemeral.privateKey, recipientIdentityKey);
      const salt = randomBytes(32);
      const info = encoder.encode(
        `${ALGORITHM}|digital-id-envelope|v1|${record.accountId}|${recipientDeviceId}`
      );
      const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
      const wrapKey = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"]
      );
      const envelopeIv = randomBytes(12);
      const wrapped = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: envelopeIv, additionalData: info },
        wrapKey,
        contentKeyBytes
      ));
      envelopes.push({
        deviceId: recipientDeviceId,
        recipientIdentityKey,
        recipientIdentitySignPublic,
        recipientIdentityDhSignature,
        ephemeralKey: ephemeral.publicKey,
        salt: bytesToBase64Url(salt),
        iv: bytesToBase64Url(envelopeIv),
        ciphertext: bytesToBase64Url(wrapped)
      });
    }
    return envelopes;
  }

  async function encryptDigitalIdVault(record, rawDigitalId, bundles) {
    const contentKeyBytes = randomBytes(32);
    const contentKey = await crypto.subtle.importKey(
      "raw",
      contentKeyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt"]
    );
    const aad = digitalIdAad(record.accountId);
    const plaintext = paddedDigitalId(rawDigitalId, record.accountId);
    const plaintextDigest = await digestBytes(plaintext);
    const iv = randomBytes(12);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
      contentKey,
      plaintext
    ));
    const envelopes = await digitalIdEnvelopes(record, contentKeyBytes, bundles);
    const vault = {
      version: 1,
      algorithm: ALGORITHM,
      ciphertext: bytesToBase64Url(ciphertext),
      iv: bytesToBase64Url(iv),
      aad,
      envelopes,
      plaintextDigest,
      senderDeviceId: record.deviceId,
      senderIdentitySignPublic: record.identitySignPublic,
      envelopeDigest: await digitalIdEnvelopeDigest(envelopes)
    };
    vault.signature = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      record.identitySignPrivate,
      digitalIdSignatureInput(vault)
    )));
    return vault;
  }

  async function decryptDigitalIdVault(record, vault) {
    if (
      Number(vault?.version || 0) !== 1
      || vault?.algorithm !== ALGORITHM
      || vault?.aad !== digitalIdAad(record.accountId)
      || await digitalIdEnvelopeDigest(vault.envelopes || []) !== String(vault.envelopeDigest || "")
    ) {
      throw e2eeError("The encrypted Digital ID vault metadata is invalid.", true);
    }
    const trustKey = `${record.accountId}:${record.accountId}:${vault.senderDeviceId}`;
    const previous = await storeGet("trust", trustKey);
    if (
      previous?.identitySignPublic
      && previous.identitySignPublic !== vault.senderIdentitySignPublic
    ) {
      throw e2eeError("The Digital ID vault signer changed.", true);
    }
    const signingKey = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(vault.senderIdentitySignPublic),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    if (!await crypto.subtle.verify(
      "Ed25519",
      signingKey,
      base64UrlToBytes(vault.signature),
      digitalIdSignatureInput(vault)
    )) {
      throw e2eeError("The Digital ID vault signature is invalid.", true);
    }
    const envelope = (vault.envelopes || []).find(
      (item) => String(item?.deviceId || "") === record.deviceId
    );
    if (
      !envelope
      || envelope.recipientIdentityKey !== record.identityDhPublic
      || envelope.recipientIdentitySignPublic !== record.identitySignPublic
      || envelope.recipientIdentityDhSignature !== record.identityDhSignature
    ) {
      throw e2eeError("This device has no Digital ID vault envelope.", true);
    }
    const shared = await deriveX25519(record.identityDhPrivate, envelope.ephemeralKey);
    const info = encoder.encode(
      `${ALGORITHM}|digital-id-envelope|v1|${record.accountId}|${record.deviceId}`
    );
    const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const wrapKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: base64UrlToBytes(envelope.salt), info },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const contentKeyBytes = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(envelope.iv),
        additionalData: info
      },
      wrapKey,
      base64UrlToBytes(envelope.ciphertext)
    ));
    const contentKey = await crypto.subtle.importKey(
      "raw",
      contentKeyBytes,
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(vault.iv),
        additionalData: encoder.encode(vault.aad)
      },
      contentKey,
      base64UrlToBytes(vault.ciphertext)
    ));
    if (await digestBytes(plaintext) !== String(vault.plaintextDigest || "")) {
      throw e2eeError("The Digital ID vault digest is invalid.", true);
    }
    await storePut("trust", {
      ...(previous || {}),
      key: trustKey,
      accountId: record.accountId,
      userId: record.accountId,
      deviceId: String(vault.senderDeviceId || ""),
      identitySignPublic: String(vault.senderIdentitySignPublic || ""),
      firstSeenAt: Number(previous?.firstSeenAt || Date.now()),
      lastSeenAt: Date.now()
    });
    return {
      rawDigitalId: openPaddedDigitalId(plaintext, record.accountId),
      contentKeyBytes
    };
  }

  function digitalIdVaultCoversBundles(vault, bundles) {
    const envelopeMap = new Map(
      (Array.isArray(vault?.envelopes) ? vault.envelopes : [])
        .map((item) => [String(item?.deviceId || ""), item])
    );
    const bundleList = Array.isArray(bundles) ? bundles : [];
    if (envelopeMap.size !== bundleList.length) return false;
    return bundleList.every((bundle) => {
      const envelope = envelopeMap.get(String(bundle?.deviceId || ""));
      return Boolean(
        envelope
        && envelope.recipientIdentityKey === bundle.identityDhPublic
        && envelope.recipientIdentitySignPublic === bundle.identitySignPublic
        && envelope.recipientIdentityDhSignature === bundle.identityDhSignature
      );
    });
  }

  async function rewrapDigitalIdVault(record, currentVault, contentKeyBytes, bundles) {
    const vault = {
      version: 1,
      algorithm: ALGORITHM,
      ciphertext: String(currentVault.ciphertext || ""),
      iv: String(currentVault.iv || ""),
      aad: String(currentVault.aad || ""),
      envelopes: await digitalIdEnvelopes(record, contentKeyBytes, bundles),
      plaintextDigest: String(currentVault.plaintextDigest || ""),
      senderDeviceId: record.deviceId,
      senderIdentitySignPublic: record.identitySignPublic
    };
    vault.envelopeDigest = await digitalIdEnvelopeDigest(vault.envelopes);
    vault.signature = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      record.identitySignPrivate,
      digitalIdSignatureInput(vault)
    )));
    return vault;
  }

  function formatDigitalId(rawDigitalId) {
    const value = String(rawDigitalId || "").replace(/[^A-ZА-Я0-9]/gi, "").toUpperCase();
    return value ? `${value.slice(0, 3)} — ${value.slice(3)}` : "";
  }

  async function digitalIdRequest(record, method = "GET", body) {
    const response = await nativeFetch("/api/digital-id", {
      method,
      headers: {
        Authorization: `Bearer ${authToken()}`,
        "Content-Type": "application/json",
        "X-YaChat-E2EE-Device": record.deviceId
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok) {
      throw e2eeError(
        String(payload.detail || `Digital ID E2EE API failed (${response.status}).`),
        true
      );
    }
    return payload;
  }

  async function ensureDigitalIdVault(record) {
    let payload = await digitalIdRequest(record);
    if (payload.migrationRequired) {
      const vault = await encryptDigitalIdVault(
        record,
        String(payload.migrationDigitalId || ""),
        payload.deviceBundles
      );
      payload = await digitalIdRequest(record, "POST", { action: "migrate", vault });
    }
    if (!payload.e2eeVault) {
      throw e2eeError("The server did not return an encrypted Digital ID vault.", true);
    }
    let opened = await decryptDigitalIdVault(record, payload.e2eeVault);
    if (
      Array.isArray(payload.deviceBundles)
      && !digitalIdVaultCoversBundles(payload.e2eeVault, payload.deviceBundles)
    ) {
      const vault = await rewrapDigitalIdVault(
        record,
        payload.e2eeVault,
        opened.contentKeyBytes,
        payload.deviceBundles
      );
      payload = await digitalIdRequest(record, "POST", { action: "rewrap", vault });
      opened = await decryptDigitalIdVault(record, payload.e2eeVault);
    }
    return {
      digitalId: formatDigitalId(opened.rawDigitalId),
      createdAt: payload.createdAt || null,
      immutable: true,
      encrypted: true
    };
  }

  async function ensureInitialized() {
    const accountId = currentAccountId();
    if (!accountId || !authToken()) return null;
    if (activeRecord && activeAccountId === accountId && status.ready) return activeRecord;
    if (initializationPromise && activeAccountId === accountId) return initializationPromise;

    activeAccountId = accountId;
    initializationPromise = (async () => {
      const supported = await supportsRequiredCrypto();
      publishStatus({ supported, ready: false, accountId, phase: "initializing", lastError: "" });
      if (!supported) {
        throw e2eeError("This browser does not support X25519, Ed25519 and P-256 Web Crypto.", true);
      }

      const currentDeviceId = deviceId(accountId);
      const storageKey = `${accountId}:${currentDeviceId}`;
      let record = await storeGet("devices", storageKey);
      if (!record) record = await createDeviceRecord(accountId, currentDeviceId);
      record = await refreshDeviceRecord(record);
      const persisted = await storeGet("devices", storageKey);
      if (!persisted?.identityDhPrivate || !persisted?.identitySignPrivate) {
        throw e2eeError("The browser cannot restore the local E2EE vault.", true);
      }
      record = persisted;
      activePushPreview = await ensurePushPreviewKey(record);
      await registerDevice(record, activePushPreview);
      activeRecord = record;
      await ensureDigitalIdVault(record);
      publishStatus({
        supported: true,
        ready: true,
        accountId,
        deviceId: currentDeviceId,
        pushPreviewPublic: activePushPreview.publicKey,
        phase: "phase5-ready",
        lastError: ""
      });
      return record;
    })().catch((error) => {
      activeRecord = null;
      activePushPreview = null;
      publishStatus({ ready: false, phase: "error", lastError: String(error?.message || error) });
      return null;
    }).finally(() => {
      initializationPromise = null;
    });
    return initializationPromise;
  }

  function activePrivateChat(chatId) {
    try {
      const chats = typeof state !== "undefined" && Array.isArray(state?.chats) ? state.chats : [];
      return chats.find((chat) => String(chat?.id || "") === String(chatId || "") && chat?.kind === "private") || null;
    } catch {
      return null;
    }
  }

  function safeRichUrl(value) {
    try {
      const source = String(value || "").trim();
      if (!source) return "";
      const prepared = /^[a-z][a-z0-9+.-]*:/i.test(source) ? source : `https://${source}`;
      const url = new URL(prepared, window.location.origin);
      return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function sanitizeRichHtml(value) {
    const source = String(value || "").slice(0, 24000);
    if (!source) return "";
    const parsed = new DOMParser().parseFromString(`<body>${source}</body>`, "text/html");
    const allowed = new Set(["STRONG", "EM", "U", "S", "CODE", "BR", "A"]);
    const output = document.createElement("div");

    const append = (node, parent) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parent.append(document.createTextNode(node.nodeValue || ""));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName === "B" ? "STRONG" : node.tagName === "I" ? "EM" : node.tagName === "DEL" ? "S" : node.tagName;
      if (!allowed.has(tag)) {
        node.childNodes.forEach((child) => append(child, parent));
        return;
      }
      if (tag === "BR") {
        parent.append(document.createElement("br"));
        return;
      }
      const element = document.createElement(tag.toLowerCase());
      if (tag === "A") {
        const href = safeRichUrl(node.getAttribute("href"));
        if (!href) {
          node.childNodes.forEach((child) => append(child, parent));
          return;
        }
        element.setAttribute("href", href);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
      node.childNodes.forEach((child) => append(child, element));
      parent.append(element);
    };

    parsed.body.childNodes.forEach((node) => append(node, output));
    return output.innerHTML.replace(/(?:<br>\s*){3,}/gi, "<br><br>").trim();
  }

  async function digestText(value) {
    return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(value || "")))));
  }

  async function digestBytes(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  }

  function canonicalAttachment(item) {
    const mime = String(item?.mime || item?.type || "application/octet-stream").slice(0, 120)
      || "application/octet-stream";
    let kind = String(item?.kind || "").slice(0, 20);
    if (!["image", "video", "file"].includes(kind)) {
      kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file";
    }
    const rawSource = String(item?.dataUrl || "").slice(0, 9000000);
    return {
      id: String(item?.id || "").slice(0, 80),
      kind,
      name: String(item?.name || "file").slice(0, 180) || "file",
      mime,
      size: Math.max(0, Math.min(Number(item?.size) || 0, 9000000)),
      source: rawSource.startsWith("data:") ? rawSource : ""
    };
  }

  async function attachmentManifest(attachments) {
    const result = [];
    for (const item of (Array.isArray(attachments) ? attachments : []).slice(0, 8)) {
      const stable = canonicalAttachment(item);
      result.push({
        kind: stable.kind,
        name: stable.name,
        mime: stable.mime,
        size: stable.size,
        digest: await digestText(JSON.stringify({
          kind: stable.kind,
          name: stable.name,
          mime: stable.mime,
          size: stable.size,
          source: stable.source
        }))
      });
    }
    return result;
  }

  function decodeAttachmentDataUrl(value) {
    const source = String(value || "");
    const comma = source.indexOf(",");
    if (!source.startsWith("data:") || comma < 6) {
      throw e2eeError("An attachment has no local binary payload.");
    }
    const header = source.slice(5, comma);
    if (!/(?:^|;)base64$/i.test(header)) {
      throw e2eeError("Only base64 attachment payloads can be encrypted.");
    }
    const declaredMime = String(header.split(";")[0] || "").slice(0, 120);
    const dataMime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(declaredMime)
      ? declaredMime
      : "application/octet-stream";
    return {
      bytes: base64ToBytes(source.slice(comma + 1)),
      dataMime
    };
  }

  function attachmentAad({ chatId, messageId, index, metadata }) {
    return `${ALGORITHM}|attachment|v1|${bytesToBase64Url(encoder.encode(JSON.stringify({
      chatId,
      messageId,
      index,
      id: metadata.id,
      kind: metadata.kind,
      name: metadata.name,
      mime: metadata.mime,
      dataMime: metadata.dataMime,
      size: metadata.size,
      byteLength: metadata.byteLength
    })))}`;
  }

  async function encryptAttachmentPayloads(attachments, contentKey, { chatId, messageId }) {
    const transport = [];
    const manifest = [];
    const sourceAttachments = (Array.isArray(attachments) ? attachments : []).slice(0, 8);
    for (let index = 0; index < sourceAttachments.length; index += 1) {
      const original = sourceAttachments[index];
      if (String(original?.dataUrl || "").length > MAX_ATTACHMENT_DATA_URL_CHARS) {
        throw e2eeError("The attachment is too large for encrypted transport.");
      }
      const stable = canonicalAttachment(original);
      if (!stable.id) stable.id = randomId("attachment");
      const decoded = decodeAttachmentDataUrl(stable.source);
      const metadata = {
        id: stable.id,
        kind: stable.kind,
        name: stable.name,
        mime: stable.mime,
        dataMime: decoded.dataMime,
        size: stable.size,
        byteLength: decoded.bytes.byteLength
      };
      const aad = attachmentAad({ chatId, messageId, index, metadata });
      const iv = randomBytes(12);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
        contentKey,
        decoded.bytes
      ));
      const encryptedDataUrl = `data:${ENCRYPTED_ATTACHMENT_MIME};base64,${bytesToBase64(ciphertext)}`;
      if (encryptedDataUrl.length > MAX_ATTACHMENT_DATA_URL_CHARS) {
        throw e2eeError("The encrypted attachment exceeds the transport limit.");
      }
      transport.push({
        id: stable.id,
        name: "encrypted",
        mime: ENCRYPTED_ATTACHMENT_MIME,
        kind: "file",
        size: ciphertext.byteLength,
        dataUrl: encryptedDataUrl
      });
      manifest.push({
        ...metadata,
        digest: await digestBytes(decoded.bytes),
        encryption: {
          version: 1,
          algorithm: "AES-GCM",
          iv: bytesToBase64Url(iv),
          aad
        }
      });
    }
    return { transport, manifest };
  }

  async function plaintextObject(payload, accountId, version, attachments) {
    return {
      version,
      messageId: String(payload.clientMessageId || ""),
      chatId: String(payload.chatId || ""),
      senderId: accountId,
      text: String(payload.text || payload.message || "").replace(/\u0000/g, "").slice(0, 4000),
      formattedHtml: sanitizeRichHtml(payload.formattedHtml || payload.formatted_html || ""),
      replyToMessageId: String(payload.replyToMessageId || ""),
      forwardedFrom: String(payload.forwardedFrom || "").slice(0, 160),
      clientCreatedAt: Number(payload.clientCreatedAt || Date.now()),
      attachments
    };
  }

  async function importX25519Public(value) {
    return crypto.subtle.importKey("raw", base64UrlToBytes(value), { name: "X25519" }, false, []);
  }

  async function deriveX25519(privateKey, publicValue) {
    const publicKey = await importX25519Public(publicValue);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: publicKey }, privateKey, 256));
  }

  async function verifySignedPreKey(bundle) {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(bundle.identitySignPublic),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify(
      "Ed25519",
      publicKey,
      base64UrlToBytes(bundle.signedPreKey.signature),
      base64UrlToBytes(bundle.signedPreKey.publicKey)
    );
  }

  async function verifyIdentityDhKey(bundle) {
    if (
      Number(bundle?.protocolVersion || PROTOCOL_VERSION) < 5
      || !bundle?.deviceId
      || !bundle?.identityDhPublic
      || !bundle?.identityDhSignature
      || !bundle?.identitySignPublic
    ) {
      return false;
    }
    const publicKey = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(bundle.identitySignPublic),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify(
      "Ed25519",
      publicKey,
      base64UrlToBytes(bundle.identityDhSignature),
      encoder.encode(identityDhKeyAttestation(
        String(bundle.deviceId || ""),
        String(bundle.identityDhPublic || "")
      ))
    );
  }

  async function verifyPushPreviewKey(bundle) {
    const preview = bundle?.pushPreview;
    if (
      Number(bundle?.protocolVersion || 0) < 4
      || !Array.isArray(bundle?.capabilities)
      || !bundle.capabilities.includes("encrypted-push-preview-v1")
      || Number(preview?.version || 0) !== 1
      || preview?.algorithm !== "P-256-HKDF-SHA256-AESGCM"
      || !preview?.publicKey
      || !preview?.signature
    ) {
      return false;
    }
    const identityKey = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(bundle.identitySignPublic),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify(
      "Ed25519",
      identityKey,
      base64UrlToBytes(preview.signature),
      encoder.encode(pushPreviewKeyAttestation(String(bundle.deviceId || ""), preview.publicKey))
    );
  }

  function notificationPreviewText(payload, attachments) {
    const plain = String(payload.text || payload.message || "").replace(/\u0000/g, "").trim();
    if (plain) return Array.from(plain).slice(0, 200).join("");
    const rich = String(payload.formattedHtml || payload.formatted_html || "");
    if (rich) {
      const parsed = new DOMParser().parseFromString(
        `<body>${sanitizeRichHtml(rich)}</body>`,
        "text/html"
      );
      const text = String(parsed.body?.textContent || "").replace(/\s+/g, " ").trim();
      if (text) return Array.from(text).slice(0, 200).join("");
    }
    const first = Array.isArray(attachments) ? attachments[0] : null;
    const kind = String(first?.kind || "");
    if (kind === "image") return "Фото";
    if (kind === "video") return "Видео";
    if (first) return "Файл";
    return "Новое сообщение";
  }

  function encryptedNotificationDescriptor(payload, messageId, body) {
    let account = {};
    try {
      account = typeof state !== "undefined" && state?.account ? state.account : {};
    } catch {
      account = window.__yachatAccount || {};
    }
    const title = String(
      account?.displayName
      || account?.display_name
      || account?.previewName
      || account?.preview_name
      || account?.username
      || "ЯЧат"
    ).slice(0, 120);
    const username = String(account?.username || "").replace(/^@+/, "").trim();
    return {
      title,
      body: String(body || "Новое сообщение").slice(0, 200),
      url: username ? `/${encodeURIComponent(username)}` : "/web",
      tag: `message:${messageId}`,
      clientCreatedAt: Date.now()
    };
  }

  function pushPreviewAad({
    version = 2,
    contextId = "",
    chatId,
    messageId,
    senderUserId,
    senderDeviceId,
    recipientUserId,
    recipientDeviceId,
    recipientPushPreviewPublic
  }) {
    if (version >= 2) {
      return `${ALGORITHM}|push-descriptor|v2|${contextId}`;
    }
    return (
      `${ALGORITHM}|push-preview|v1|${chatId}|${messageId}|${senderUserId}|`
      + `${senderDeviceId}|${recipientUserId}|${recipientDeviceId}|${recipientPushPreviewPublic}`
    );
  }

  function pushPreviewSignatureInput(preview) {
    return encoder.encode([
      preview.aad,
      preview.senderIdentitySignPublic,
      preview.ephemeralKey,
      preview.salt,
      preview.iv,
      preview.ciphertext
    ].join("|"));
  }

  function sealedPushDescriptorSignatureInput(descriptor) {
    return encoder.encode(JSON.stringify([
      ALGORITHM,
      "push-descriptor-content",
      1,
      descriptor.contextId,
      descriptor.messageId,
      descriptor.title,
      descriptor.body,
      descriptor.url,
      descriptor.tag,
      descriptor.clientCreatedAt,
      descriptor.createdAt,
      descriptor.senderDeviceId,
      descriptor.senderIdentitySignPublic
    ]));
  }

  async function paddedPushPreview(record, descriptor, messageId) {
    const safe = {
      title: String(descriptor?.title || "ЯЧат").slice(0, 120),
      body: String(descriptor?.body || "Новое сообщение").slice(0, 200),
      url: String(descriptor?.url || "/web").slice(0, 300),
      tag: String(descriptor?.tag || `message:${messageId}`).slice(0, 240),
      clientCreatedAt: Number(descriptor?.clientCreatedAt || Date.now()),
      contextId: String(descriptor?.contextId || "")
    };
    let encoded;
    while (true) {
      const sealed = {
        version: 2,
        messageId,
        ...safe,
        createdAt: Date.now(),
        senderDeviceId: record.deviceId,
        senderIdentitySignPublic: record.identitySignPublic
      };
      sealed.signature = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign(
        "Ed25519",
        record.identitySignPrivate,
        sealedPushDescriptorSignatureInput(sealed)
      )));
      encoded = encoder.encode(JSON.stringify(sealed));
      if (encoded.byteLength <= PUSH_PREVIEW_PLAINTEXT_BYTES - 2) break;
      if (safe.body.length > 32) safe.body = safe.body.slice(0, -8);
      else if (safe.url.length > 80) safe.url = safe.url.slice(0, -8);
      else if (safe.tag.length > 80) safe.tag = safe.tag.slice(0, -8);
      else if (safe.title.length > 32) safe.title = safe.title.slice(0, -8);
      else throw e2eeError("The sealed push descriptor is too large.", true);
    }
    const padded = randomBytes(PUSH_PREVIEW_PLAINTEXT_BYTES);
    padded[0] = (encoded.byteLength >>> 8) & 0xff;
    padded[1] = encoded.byteLength & 0xff;
    padded.set(encoded, 2);
    return padded;
  }

  async function pushPreviewForBundle(record, bundle, { chatId, messageId, descriptor }) {
    if (!await verifyPushPreviewKey(bundle)) {
      throw e2eeError(`The push-preview key for device ${bundle?.deviceId || "unknown"} is invalid.`, true);
    }
    const recipientPushPreviewPublic = String(bundle.pushPreview.publicKey);
    const version = 2;
    const contextId = bytesToBase64Url(randomBytes(32));
    const aad = pushPreviewAad({
      version,
      contextId,
      senderDeviceId: record.deviceId,
      recipientDeviceId: String(bundle.deviceId || ""),
      recipientPushPreviewPublic
    });
    const recipientPublic = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(recipientPushPreviewPublic),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );
    const ephemeral = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const shared = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "ECDH", public: recipientPublic },
      ephemeral.privateKey,
      256
    ));
    const salt = randomBytes(32);
    const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(aad) },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );
    const iv = randomBytes(12);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
      key,
      await paddedPushPreview(record, { ...descriptor, contextId }, messageId)
    ));
    const preview = {
      version,
      contextId,
      deviceId: String(bundle.deviceId || ""),
      senderDeviceId: record.deviceId,
      senderIdentitySignPublic: record.identitySignPublic,
      recipientPushPreviewPublic,
      ephemeralKey: bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))),
      salt: bytesToBase64Url(salt),
      iv: bytesToBase64Url(iv),
      ciphertext: bytesToBase64Url(ciphertext),
      aad
    };
    const signature = new Uint8Array(await crypto.subtle.sign(
      "Ed25519",
      record.identitySignPrivate,
      pushPreviewSignatureInput(preview)
    ));
    return { ...preview, signature: bytesToBase64Url(signature) };
  }

  async function trustBundle(accountId, bundle) {
    if (Number(bundle?.protocolVersion || 0) >= 5 && !await verifyIdentityDhKey(bundle)) {
      throw e2eeError(`The identity key attestation for device ${bundle?.deviceId || "unknown"} is invalid.`, true);
    }
    const key = `${accountId}:${bundle.userId}:${bundle.deviceId}`;
    const fingerprintBytes = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      concatBytes([base64UrlToBytes(bundle.identityDhPublic), base64UrlToBytes(bundle.identitySignPublic)])
    ));
    const fingerprint = bytesToBase64Url(fingerprintBytes);
    const previous = await storeGet("trust", key);
    if (
      (previous?.fingerprint && previous.fingerprint !== fingerprint)
      || (
        previous?.identitySignPublic
        && previous.identitySignPublic !== String(bundle.identitySignPublic || "")
      )
    ) {
      throw e2eeError(`The identity key for device ${bundle.deviceId} changed.`, true);
    }
    await storePut("trust", {
      key,
      accountId,
      userId: String(bundle.userId || ""),
      deviceId: String(bundle.deviceId || ""),
      fingerprint,
      identitySignPublic: String(bundle.identitySignPublic || ""),
      firstSeenAt: Number(previous?.firstSeenAt || Date.now()),
      lastSeenAt: Date.now()
    });
    return fingerprint;
  }

  async function verifyAndPinMessageSignature(record, message, e2ee) {
    if (Number(e2ee?.version || 0) < 5) return;
    if (
      String(e2ee.paddingScheme || "") !== "bucket-v1"
      || !e2ee.senderIdentitySignPublic
      || !e2ee.signature
      || await envelopeDigest(e2ee.envelopes) !== String(e2ee.envelopeDigest || "")
    ) {
      throw e2eeError("The phase 5 message signature metadata is invalid.");
    }
    const trustKey = `${record.accountId}:${message.authorId}:${e2ee.senderDeviceId}`;
    const previous = await storeGet("trust", trustKey);
    if (
      previous?.identitySignPublic
      && previous.identitySignPublic !== e2ee.senderIdentitySignPublic
    ) {
      throw e2eeError("The message sender identity key changed.", true);
    }
    const publicKey = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(e2ee.senderIdentitySignPublic),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      base64UrlToBytes(e2ee.signature),
      messageSignatureInput(e2ee)
    );
    if (!valid) throw e2eeError("The phase 5 message signature is invalid.");
    await storePut("trust", {
      ...(previous || {}),
      key: trustKey,
      accountId: record.accountId,
      userId: String(message.authorId || ""),
      deviceId: String(e2ee.senderDeviceId || ""),
      identitySignPublic: String(e2ee.senderIdentitySignPublic || ""),
      firstSeenAt: Number(previous?.firstSeenAt || Date.now()),
      lastSeenAt: Date.now()
    });
  }

  async function envelopeForBundle(record, bundle, contentKeyBytes, messageId) {
    if (bundle.algorithm !== ALGORITHM) throw e2eeError("Unsupported recipient E2EE algorithm.", true);
    if (!await verifySignedPreKey(bundle)) throw e2eeError("Recipient signed prekey verification failed.", true);
    await trustBundle(record.accountId, bundle);

    const ephemeral = await hardenedKeyPair("X25519", [], ["deriveBits"]);
    const dhParts = [
      await deriveX25519(record.identityDhPrivate, bundle.signedPreKey.publicKey),
      await deriveX25519(ephemeral.privateKey, bundle.identityDhPublic),
      await deriveX25519(ephemeral.privateKey, bundle.signedPreKey.publicKey)
    ];
    if (bundle.oneTimePreKey?.publicKey) dhParts.push(await deriveX25519(ephemeral.privateKey, bundle.oneTimePreKey.publicKey));

    const salt = randomBytes(32);
    const info = encoder.encode(`${ALGORITHM}|envelope|${messageId}|${bundle.deviceId}`);
    const hkdfMaterial = await crypto.subtle.importKey("raw", concatBytes(dhParts), "HKDF", false, ["deriveKey"]);
    const wrapKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info },
      hkdfMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );
    const iv = randomBytes(12);
    const wrapped = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: info },
      wrapKey,
      contentKeyBytes
    ));

    return {
      deviceId: String(bundle.deviceId),
      userId: String(bundle.userId),
      signedPreKeyId: String(bundle.signedPreKey.id),
      oneTimePreKeyId: String(bundle.oneTimePreKey?.id || ""),
      senderIdentityKey: record.identityDhPublic,
      ephemeralKey: ephemeral.publicKey,
      salt: bytesToBase64Url(salt),
      iv: bytesToBase64Url(iv),
      ciphertext: bytesToBase64Url(wrapped)
    };
  }

  function contentAad({ version, chatId, messageId, senderDeviceId, epochId, attachmentMode }) {
    const base = `${ALGORITHM}|content|v${version}|${chatId}|${messageId}|${senderDeviceId}|${epochId || "shadow"}`;
    return version >= 3 ? `${base}|attachments-${attachmentMode}` : base;
  }

  async function envelopeDigest(envelopes) {
    const fields = [
      "deviceId",
      "signedPreKeyId",
      "oneTimePreKeyId",
      "senderIdentityKey",
      "ephemeralKey",
      "salt",
      "iv",
      "ciphertext"
    ];
    const material = [...envelopes]
      .sort((left, right) => String(left?.deviceId || "").localeCompare(String(right?.deviceId || "")))
      .map((item) => fields.map((field) => String(item?.[field] || "")).join("|"))
      .join("\n");
    return digestText(material);
  }

  function messageSignatureInput(e2ee) {
    return encoder.encode(
      `${ALGORITHM}|message-signature|v1|${e2ee.aad}|${e2ee.iv}|`
      + `${e2ee.ciphertext}|${e2ee.plaintextDigest}|${e2ee.envelopeDigest}`
    );
  }

  function bucketPaddedContent(plaintextBytes) {
    const required = plaintextBytes.byteLength + 4;
    const bucket = CONTENT_PADDING_BUCKETS.find((size) => size >= required);
    if (!bucket) throw e2eeError("The encrypted message is too large for phase 5 padding.", true);
    const padded = randomBytes(bucket);
    const view = new DataView(padded.buffer);
    view.setUint32(0, plaintextBytes.byteLength, false);
    padded.set(plaintextBytes, 4);
    return padded;
  }

  function openBucketPaddedContent(padded) {
    if (!CONTENT_PADDING_BUCKETS.includes(padded.byteLength) || padded.byteLength < 5) {
      throw e2eeError("The encrypted message padding bucket is invalid.");
    }
    const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, false);
    if (length <= 0 || length > padded.byteLength - 4) {
      throw e2eeError("The encrypted message padding length is invalid.");
    }
    return padded.subarray(4, 4 + length);
  }

  async function buildProtectedPayload(payload, record) {
    const chatId = String(payload.chatId || "");
    const messageId = String(payload.clientMessageId || "");
    if (!chatId || !messageId || !activePrivateChat(chatId)) return null;

    const claimed = await apiJson("/api/e2ee/bundles/claim", {
      body: { chatId, senderDeviceId: record.deviceId }
    });
    if (claimed.rolloutPhase === "blocked" || claimed.ok === false) {
      throw e2eeError(String(claimed.reason || "A participant has no ready E2EE device."), true);
    }
    const mode = claimed.rolloutPhase === "encrypted" ? "encrypted" : "shadow";
    const epochId = mode === "encrypted" ? String(claimed.epochId || "") : "";
    const bundles = Array.isArray(claimed.bundles) ? claimed.bundles : [];
    if (!bundles.length) throw e2eeError("No E2EE recipient devices are available.", mode === "encrypted");

    if (mode === "encrypted") {
      const required = new Set(Array.isArray(claimed.requiredDeviceIds) ? claimed.requiredDeviceIds.map(String) : []);
      const received = new Set(bundles.map((bundle) => String(bundle.deviceId || "")));
      if (!epochId || required.size === 0 || required.size !== received.size || [...required].some((id) => !received.has(id))) {
        throw e2eeError("The E2EE device roster is incomplete.", true);
      }
    }

    const sourceAttachments = (Array.isArray(payload.attachments) ? payload.attachments : []).slice(0, 8);
    const phase3BundlesReady = bundles.every((bundle) => (
      Number(bundle?.protocolVersion || 0) >= 3
      && Array.isArray(bundle?.capabilities)
      && bundle.capabilities.includes("encrypted-attachments-v1")
    ));
    const phase5Required = Number(claimed.minimumProtocolVersion || 0) >= 5;
    const phase5BundlesReady = bundles.every((bundle) => (
      Number(bundle?.protocolVersion || 0) >= 5
      && Array.isArray(bundle?.capabilities)
      && PHASE5_CAPABILITIES.every((capability) => bundle.capabilities.includes(capability))
    ));
    if (phase5Required && !phase5BundlesReady) {
      throw e2eeError("Every participant must finish the phase 5 E2EE migration.", true);
    }
    if (
      phase5Required
      && sourceAttachments.length > 0
      && claimed.attachmentEncryptionReady !== true
    ) {
      throw e2eeError("Phase 5 refused to expose an attachment without E2EE.", true);
    }
    const encryptAttachments = (
      mode === "encrypted"
      && sourceAttachments.length > 0
      && claimed.attachmentEncryptionReady === true
      && phase3BundlesReady
    );
    const version = phase5Required ? 5 : encryptAttachments ? 3 : 2;
    const attachmentMode = version >= 3 ? "encrypted" : "plaintext";
    const contentKeyBytes = randomBytes(32);
    const contentKey = await crypto.subtle.importKey(
      "raw",
      contentKeyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt"]
    );
    const protectedAttachments = encryptAttachments
      ? await encryptAttachmentPayloads(sourceAttachments, contentKey, { chatId, messageId })
      : { transport: sourceAttachments, manifest: await attachmentManifest(sourceAttachments) };
    const plaintext = await plaintextObject(
      payload,
      record.accountId,
      version,
      protectedAttachments.manifest
    );
    const plaintextBytes = encoder.encode(JSON.stringify(plaintext));
    const protectedPlaintextBytes = version >= 5 ? bucketPaddedContent(plaintextBytes) : plaintextBytes;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", protectedPlaintextBytes));
    const iv = randomBytes(12);
    const aad = contentAad({
      version,
      chatId,
      messageId,
      senderDeviceId: record.deviceId,
      epochId,
      attachmentMode
    });
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
      contentKey,
      protectedPlaintextBytes
    ));
    await cacheMessageKey(record, messageId, contentKeyBytes);

    const envelopes = [];
    for (const bundle of bundles) envelopes.push(await envelopeForBundle(record, bundle, contentKeyBytes, messageId));
    const pushPreviews = [];
    if (mode === "encrypted") {
      const previewBody = notificationPreviewText(payload, sourceAttachments);
      const descriptor = encryptedNotificationDescriptor(payload, messageId, previewBody);
      for (const bundle of bundles) {
        const phase4 = Number(bundle?.protocolVersion || 0) >= 4
          && Array.isArray(bundle?.capabilities)
          && bundle.capabilities.includes("encrypted-push-preview-v1");
        if (phase4) {
          pushPreviews.push(await pushPreviewForBundle(record, bundle, {
            chatId,
            messageId,
            descriptor
          }));
        }
      }
    }
    const encryptedMessage = {
      version,
      mode,
      attachmentMode,
      paddingScheme: version >= 5 ? "bucket-v1" : "",
      epochId,
      messageId,
      chatId,
      senderDeviceId: record.deviceId,
      ciphertext: bytesToBase64Url(ciphertext),
      iv: bytesToBase64Url(iv),
      aad,
      plaintextDigest: bytesToBase64Url(digest),
      envelopes,
      pushPreviews
    };
    if (version >= 5) {
      encryptedMessage.envelopeDigest = await envelopeDigest(envelopes);
      encryptedMessage.senderIdentitySignPublic = record.identitySignPublic;
      encryptedMessage.signature = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign(
        "Ed25519",
        record.identitySignPrivate,
        messageSignatureInput(encryptedMessage)
      )));
    }
    return {
      mode,
      attachments: protectedAttachments.transport,
      e2ee: encryptedMessage
    };
  }

  async function prepareMessageRequest(input, init, meta) {
    if (meta.pathname !== "/api/message" || meta.method !== "POST" || typeof init?.body !== "string") return { input, init };
    let payload;
    try {
      payload = JSON.parse(init.body);
    } catch {
      return { input, init };
    }
    const chat = activePrivateChat(payload?.chatId);
    if (!payload || payload.e2ee || !chat) return { input, init };

    const record = await ensureInitialized();
    if (!record) {
      if (chat.e2eePolicy === "text_encrypted") throw e2eeError("This chat requires E2EE, but this device is not ready.", true);
      return { input, init };
    }

    try {
      const protectedPayload = await buildProtectedPayload(payload, record);
      if (!protectedPayload) return { input, init };
      const headers = new Headers(init.headers || {});
      headers.set("Content-Type", "application/json");
      const nextPayload = protectedPayload.mode === "encrypted"
        ? {
            ...payload,
            text: "",
            message: "",
            formattedHtml: "",
            formatted_html: "",
            replyToMessageId: null,
            forwardedFrom: "",
            attachments: protectedPayload.attachments,
            e2ee: protectedPayload.e2ee
          }
        : { ...payload, attachments: protectedPayload.attachments, e2ee: protectedPayload.e2ee };
      publishStatus({ phase: protectedPayload.mode, lastError: "" });
      return { input, init: { ...init, headers, body: JSON.stringify(nextPayload) } };
    } catch (error) {
      publishStatus({ lastError: String(error?.message || error) });
      if (error?.e2eeFatal || chat.e2eePolicy === "text_encrypted") throw error;
      return { input, init };
    }
  }

  function messageIdFromAad(value) {
    const parts = String(value || "").split("|");
    if (parts[0] !== ALGORITHM || parts[1] !== "content") return "";
    if (parts.length === 7 && /^v[12]$/.test(parts[2])) return parts[4];
    if (
      parts.length === 8
      && ["v3", "v5"].includes(parts[2])
      && parts[7] === "attachments-encrypted"
    ) return parts[4];
    // Phase 1 used algorithm|content|chat|message|device.
    if (parts.length === 5) return parts[3];
    return "";
  }

  async function unwrapContentKey(record, e2ee, envelope) {
    const messageId = messageIdFromAad(e2ee.aad);
    if (!messageId) throw e2eeError("The encrypted message has invalid associated data.");
    const cached = await cachedMessageKey(record, messageId);
    if (cached) return cached;

    const signed = (record.signedPreKeys || []).find((item) => item.id === envelope.signedPreKeyId);
    if (!signed) throw e2eeError("The required signed prekey is no longer on this device.");
    const dhParts = [
      await deriveX25519(signed.privateKey, envelope.senderIdentityKey),
      await deriveX25519(record.identityDhPrivate, envelope.ephemeralKey),
      await deriveX25519(signed.privateKey, envelope.ephemeralKey)
    ];
    if (envelope.oneTimePreKeyId) {
      const prekey = (record.oneTimePreKeys || []).find((item) => item.id === envelope.oneTimePreKeyId);
      if (!prekey) throw e2eeError("The required one-time prekey is no longer on this device.");
      dhParts.push(await deriveX25519(prekey.privateKey, envelope.ephemeralKey));
    }

    const salt = base64UrlToBytes(envelope.salt);
    const info = encoder.encode(`${ALGORITHM}|envelope|${messageId}|${record.deviceId}`);
    const hkdfMaterial = await crypto.subtle.importKey("raw", concatBytes(dhParts), "HKDF", false, ["deriveKey"]);
    const wrapKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info },
      hkdfMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const contentKeyBytes = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(envelope.iv), additionalData: info },
      wrapKey,
      base64UrlToBytes(envelope.ciphertext)
    ));
    await cacheMessageKey(record, messageId, contentKeyBytes);
    if (envelope.oneTimePreKeyId) {
      record.oneTimePreKeys = (record.oneTimePreKeys || []).filter(
        (item) => item.id !== envelope.oneTimePreKeyId
      );
      await storePut("devices", record);
    }
    return contentKeyBytes;
  }

  async function verifyAttachmentManifest(actualAttachments, expectedManifest, e2eeVersion) {
    const actual = await attachmentManifest(actualAttachments);
    const expected = Array.isArray(expectedManifest) ? expectedManifest : [];
    if (actual.length !== expected.length) return false;
    return actual.every((item, index) => {
      const expectedItem = expected[index] || {};
      const baseMatches = item.kind === String(expectedItem.kind || "")
        && item.name === String(expectedItem.name || "")
        && item.mime === String(expectedItem.mime || "")
        && item.size === Number(expectedItem.size || 0);
      // Phase 1 authenticated only the manifest fields. Phase 2 also binds
      // the canonical server attachment to the encrypted digest.
      return baseMatches && (Number(e2eeVersion) === 1 || item.digest === String(expectedItem.digest || ""));
    });
  }

  async function decryptAttachmentPayloads(actualAttachments, expectedManifest, contentKey, context) {
    const actual = Array.isArray(actualAttachments) ? actualAttachments : [];
    const expected = Array.isArray(expectedManifest) ? expectedManifest : [];
    if (actual.length !== expected.length) {
      throw e2eeError("The encrypted attachment set is incomplete.");
    }
    if (expected.length === 0) return [];

    const result = [];
    const prefix = `data:${ENCRYPTED_ATTACHMENT_MIME};base64,`;
    for (let index = 0; index < expected.length; index += 1) {
      const transport = actual[index] || {};
      const source = String(transport.dataUrl || "");
      const encrypted = expected[index] || {};
      const encryption = encrypted.encryption || {};
      if (
        String(transport.id || "") !== String(encrypted.id || "")
        || String(transport.name || "") !== "encrypted"
        || String(transport.mime || "") !== ENCRYPTED_ATTACHMENT_MIME
        || String(transport.kind || "") !== "file"
        || !source.startsWith(prefix)
        || Number(encryption.version || 0) !== 1
        || String(encryption.algorithm || "") !== "AES-GCM"
      ) {
        throw e2eeError("The encrypted attachment transport is invalid.");
      }

      const metadata = {
        id: String(encrypted.id || "").slice(0, 80),
        kind: ["image", "video", "file"].includes(String(encrypted.kind || ""))
          ? String(encrypted.kind)
          : "file",
        name: String(encrypted.name || "file").slice(0, 180) || "file",
        mime: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(String(encrypted.mime || ""))
          ? String(encrypted.mime).slice(0, 120)
          : "application/octet-stream",
        dataMime: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(String(encrypted.dataMime || ""))
          ? String(encrypted.dataMime).slice(0, 120)
          : "application/octet-stream",
        size: Math.max(0, Math.min(Number(encrypted.size) || 0, 9000000)),
        byteLength: Math.max(0, Math.min(Number(encrypted.byteLength) || 0, 9000000))
      };
      const aad = attachmentAad({ ...context, index, metadata });
      if (aad !== String(encryption.aad || "")) {
        throw e2eeError("The encrypted attachment context was modified.");
      }

      const ciphertext = base64ToBytes(source.slice(prefix.length));
      if (Number(transport.size || 0) !== ciphertext.byteLength) {
        throw e2eeError("The encrypted attachment size was modified.");
      }
      const plaintext = new Uint8Array(await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64UrlToBytes(encryption.iv),
          additionalData: encoder.encode(aad)
        },
        contentKey,
        ciphertext
      ));
      if (plaintext.byteLength !== metadata.byteLength || await digestBytes(plaintext) !== String(encrypted.digest || "")) {
        throw e2eeError("The encrypted attachment failed its integrity check.");
      }
      result.push({
        id: metadata.id,
        kind: metadata.kind,
        name: metadata.name,
        mime: metadata.mime,
        size: metadata.size,
        dataUrl: `data:${metadata.dataMime};base64,${bytesToBase64(plaintext)}`,
        encrypted: true,
        e2eeEncrypted: true
      });
    }
    return result;
  }

  function assertContentContext(message, e2ee) {
    const version = Number(e2ee.version || 0);
    const mode = String(e2ee.mode || "");
    const attachmentMode = String(e2ee.attachmentMode || "plaintext");
    if (!["shadow", "encrypted"].includes(mode)) {
      throw e2eeError("The encrypted message mode is invalid.");
    }
    if (version === 1 && mode !== "shadow") {
      throw e2eeError("Protocol version 1 is limited to shadow messages.");
    }
    if (version >= 3 && (mode !== "encrypted" || attachmentMode !== "encrypted")) {
      throw e2eeError("The encrypted attachment mode was downgraded.");
    }
    if (version < 3 && attachmentMode !== "plaintext") {
      throw e2eeError("The encrypted attachment mode does not match the protocol version.");
    }
    if (version >= 5 && String(e2ee.paddingScheme || "") !== "bucket-v1") {
      throw e2eeError("The encrypted message padding was downgraded.");
    }

    const chatId = String(message.chatId || "");
    const messageId = String(message.id || "");
    const senderDeviceId = String(e2ee.senderDeviceId || "");
    const actual = String(e2ee.aad || "");
    const expected = contentAad({
      version,
      chatId,
      messageId,
      senderDeviceId,
      epochId: String(e2ee.epochId || ""),
      attachmentMode
    });
    const legacyShadow = `${ALGORITHM}|content|${chatId}|${messageId}|${senderDeviceId}`;
    if (actual !== expected && !(version === 1 && mode === "shadow" && actual === legacyShadow)) {
      throw e2eeError("The encrypted message context was modified.");
    }
  }

  async function decryptMessage(message, record) {
    const e2ee = message?.e2ee;
    if (!e2ee || ![1, 2, 3, 5].includes(Number(e2ee.version)) || !Array.isArray(e2ee.envelopes)) return message;
    const envelope = e2ee.envelopes.find((item) => String(item?.deviceId || "") === record.deviceId);
    if (!envelope) {
      if (e2ee.mode === "encrypted") {
        return {
          ...message,
          text: "Сообщение зашифровано для другого устройства",
          formattedHtml: "",
          e2eeVerified: false,
          e2eeUnavailable: true
        };
      }
      return { ...message, e2eeVerified: false, e2eeUnavailable: true };
    }

    try {
      assertContentContext(message, e2ee);
      await verifyAndPinMessageSignature(record, message, e2ee);
      const contentKeyBytes = await unwrapContentKey(record, e2ee, envelope);
      const contentKey = await crypto.subtle.importKey("raw", contentKeyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
      const protectedPlaintextBytes = new Uint8Array(await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64UrlToBytes(e2ee.iv),
          additionalData: encoder.encode(String(e2ee.aad || ""))
        },
        contentKey,
        base64UrlToBytes(e2ee.ciphertext)
      ));
      const digest = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", protectedPlaintextBytes)));
      if (digest !== String(e2ee.plaintextDigest || "")) throw e2eeError("E2EE plaintext digest mismatch.");
      const plaintextBytes = Number(e2ee.version) >= 5
        ? openBucketPaddedContent(protectedPlaintextBytes)
        : protectedPlaintextBytes;
      const plaintext = JSON.parse(decoder.decode(plaintextBytes));
      if (
        Number(plaintext.version || 0) !== Number(e2ee.version)
        || String(plaintext.messageId || "") !== String(message.id || "")
        || String(plaintext.chatId || "") !== String(message.chatId || "")
        || String(plaintext.senderId || "") !== String(message.authorId || "")
      ) {
        throw e2eeError("The decrypted message context is invalid.");
      }
      const attachments = Number(e2ee.version) >= 3 && e2ee.attachmentMode === "encrypted"
        ? await decryptAttachmentPayloads(message.attachments, plaintext.attachments, contentKey, {
            chatId: String(message.chatId || ""),
            messageId: String(message.id || "")
          })
        : message.attachments;
      if (
        Number(e2ee.version) < 3
        && !await verifyAttachmentManifest(message.attachments, plaintext.attachments, e2ee.version)
      ) {
        throw e2eeError("The message attachment metadata was modified.");
      }

      if (e2ee.mode === "shadow") {
        const sameText = String(message.text || "") === String(plaintext.text || "");
        const sameReply = String(message.replyToMessageId || "") === String(plaintext.replyToMessageId || "");
        const sameForward = String(message.forwardedFrom || "") === String(plaintext.forwardedFrom || "");
        if (!sameText || !sameReply || !sameForward) throw e2eeError("The E2EE shadow copy does not match the server copy.");
      }

      const result = { ...message, e2eeVerified: true, e2eeUnavailable: false };
      if (e2ee.mode === "encrypted") {
        result.text = String(plaintext.text || "");
        result.formattedHtml = sanitizeRichHtml(plaintext.formattedHtml || "");
        result.replyToMessageId = String(plaintext.replyToMessageId || "") || null;
        result.forwardedFrom = String(plaintext.forwardedFrom || "");
        if (Number(plaintext.clientCreatedAt || 0) > 0) {
          result.clientCreatedAt = Number(plaintext.clientCreatedAt);
        }
        result.attachments = attachments;
      }
      publishStatus({
        verifiedMessages: status.verifiedMessages + 1,
        encryptedMessages: status.encryptedMessages + (e2ee.mode === "encrypted" ? 1 : 0),
        shadowMessages: status.shadowMessages + (e2ee.mode === "shadow" ? 1 : 0),
        lastError: ""
      });
      return result;
    } catch (error) {
      publishStatus({ verificationFailures: status.verificationFailures + 1, lastError: String(error?.message || error) });
      return {
        ...message,
        text: e2ee.mode === "encrypted" ? "Не удалось проверить защищённое сообщение" : message.text,
        formattedHtml: e2ee.mode === "encrypted" ? "" : message.formattedHtml,
        e2eeVerified: false,
        e2eeUnavailable: false
      };
    }
  }

  async function decryptResponsePayload(payload) {
    const record = await ensureInitialized();
    if (!record || !payload) return payload;
    if (Array.isArray(payload)) return Promise.all(payload.map((item) => decryptMessage(item, record)));
    if (typeof payload !== "object") return payload;
    const output = { ...payload };
    if (output.message && typeof output.message === "object") output.message = await decryptMessage(output.message, record);
    if (Array.isArray(output.messages)) output.messages = await Promise.all(output.messages.map((item) => decryptMessage(item, record)));
    return output;
  }

  function requestMeta(input, init = {}) {
    try {
      const source = typeof input === "string" || input instanceof URL ? input : input?.url || "";
      const url = new URL(source, window.location.origin);
      return {
        sameOrigin: url.origin === window.location.origin,
        pathname: url.pathname,
        method: String(init.method || input?.method || "GET").toUpperCase()
      };
    } catch {
      return { sameOrigin: false, pathname: "", method: "GET" };
    }
  }

  function shouldInspectResponse(meta, response) {
    return meta.sameOrigin
      && response?.ok
      && ["/api/message", "/api/messages", "/api/bootstrap", "/api/messenger"].includes(meta.pathname)
      && String(response.headers.get("content-type") || "").includes("application/json");
  }

  window.fetch = async function yachatE2EEPhase2Fetch(input, init = {}) {
    const meta = requestMeta(input, init);
    if (
      meta.sameOrigin
      && meta.pathname === "/api/digital-id"
      && ["GET", "POST"].includes(meta.method)
    ) {
      const record = await ensureInitialized();
      if (!record) throw e2eeError("The encrypted Digital ID vault is unavailable.", true);
      const digitalId = await ensureDigitalIdVault(record);
      return new Response(JSON.stringify(digitalId), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-YaChat-E2EE-Runtime": "phase5"
        }
      });
    }
    const prepared = meta.sameOrigin ? await prepareMessageRequest(input, init, meta) : { input, init };
    const response = await nativeFetch(prepared.input, prepared.init);
    if (!shouldInspectResponse(meta, response)) return response;
    try {
      const payload = await response.clone().json();
      const decrypted = await decryptResponsePayload(payload);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("X-YaChat-E2EE-Runtime", "phase5");
      return new Response(JSON.stringify(decrypted), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch {
      return response;
    }
  };

  async function periodicMaintenance() {
    const accountId = currentAccountId();
    if (!accountId || !authToken()) return;
    if (accountId !== activeAccountId || !status.ready) {
      const now = Date.now();
      if (now - lastInitializationAttempt < 5000) return;
      lastInitializationAttempt = now;
      await ensureInitialized();
      return;
    }
    if (activeRecord && Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
      try {
        await heartbeat(activeRecord);
      } catch (error) {
        publishStatus({ lastError: String(error?.message || error) });
      }
    }
  }

  publishStatus({ supported: false, ready: false, phase: "initializing", protocolVersion: PROTOCOL_VERSION });
  queueMicrotask(() => periodicMaintenance());
  window.setInterval(periodicMaintenance, 10_000);
})();

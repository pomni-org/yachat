(() => {
  "use strict";

  if (window.__yachatE2EERuntimeInstalled) return;
  window.__yachatE2EERuntimeInstalled = true;

  const ALGORITHM = "yachat-x3dh-v1";
  const ROLLOUT_PHASE = "shadow";
  const AUTH_TOKEN_KEY = "yachat-http-auth-token";
  const DEVICE_ID_KEY = "yachat-e2ee-device-id-v1";
  const PUSH_DEVICE_ID_KEY = "yachat-push-installation-id-v1";
  const DB_NAME = "yachat-e2ee-v1";
  const DB_VERSION = 1;
  const SIGNED_PREKEY_ROTATION_MS = 14 * 24 * 60 * 60 * 1000;
  const PREKEY_TARGET = 32;
  const MAX_LOCAL_PREKEYS = 220;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const nativeFetch = window.fetch.bind(window);

  let databasePromise = null;
  let initializationPromise = null;
  let activeAccountId = "";
  let activeRecord = null;
  let lastInitializationAttempt = 0;
  let status = {
    supported: false,
    ready: false,
    phase: ROLLOUT_PHASE,
    deviceId: "",
    accountId: "",
    verifiedMessages: 0,
    verificationFailures: 0,
    lastError: ""
  };

  function publishStatus(patch = {}) {
    status = { ...status, ...patch };
    window.__yachatE2EE = Object.freeze({ ...status });
    window.dispatchEvent(new CustomEvent("yachat:e2ee-status", { detail: { ...status } }));
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

  function deviceId() {
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

  async function openDatabase() {
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
  }

  async function hardenedKeyPair(name, publicUsages, privateUsages) {
    const pair = await crypto.subtle.generateKey({ name }, true, [...new Set([...publicUsages, ...privateUsages])]);
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name }, false, privateUsages);
    return { publicKey: bytesToBase64Url(publicRaw), privateKey };
  }

  async function createSignedPreKey(identitySignPrivate) {
    const pair = await hardenedKeyPair("X25519", [], ["deriveBits"]);
    const rawPublic = base64UrlToBytes(pair.publicKey);
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", identitySignPrivate, rawPublic));
    return {
      id: randomId("spk"),
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
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
      return Boolean(x?.privateKey && e?.privateKey);
    } catch {
      return false;
    }
  }

  async function createDeviceRecord(accountId, currentDeviceId) {
    const identityDh = await hardenedKeyPair("X25519", [], ["deriveBits"]);
    const identitySign = await hardenedKeyPair("Ed25519", ["verify"], ["sign"]);
    const signedPreKey = await createSignedPreKey(identitySign.privateKey);
    return {
      key: `${accountId}:${currentDeviceId}`,
      accountId,
      deviceId: currentDeviceId,
      algorithm: ALGORITHM,
      identityDhPublic: identityDh.publicKey,
      identityDhPrivate: identityDh.privateKey,
      identitySignPublic: identitySign.publicKey,
      identitySignPrivate: identitySign.privateKey,
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
    record.updatedAt = Date.now();
    await storePut("devices", record);
    return record;
  }

  function authToken() {
    return safeStorageGet(AUTH_TOKEN_KEY).trim();
  }

  async function apiJson(path, { method = "POST", body } = {}) {
    const token = authToken();
    if (!token) throw new Error("E2EE registration requires an authenticated account.");
    const response = await nativeFetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
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
    if (!response.ok) throw new Error(String(payload.detail || `E2EE API failed (${response.status}).`));
    return payload;
  }

  function registrationPayload(record) {
    const signed = record.signedPreKeys.at(-1);
    return {
      deviceId: record.deviceId,
      algorithm: ALGORITHM,
      identityDhPublic: record.identityDhPublic,
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

  async function registerDevice(record) {
    let result = await apiJson("/api/e2ee/device/register", { body: registrationPayload(record) });
    if (result.needsOneTimePreKeys) {
      record.oneTimePreKeys.push(...await generatePreKeys(PREKEY_TARGET));
      if (record.oneTimePreKeys.length > MAX_LOCAL_PREKEYS) {
        record.oneTimePreKeys = record.oneTimePreKeys.slice(-MAX_LOCAL_PREKEYS);
      }
      await storePut("devices", record);
      result = await apiJson("/api/e2ee/device/register", { body: registrationPayload(record) });
    }
    return result;
  }

  function currentAccountId() {
    try {
      return String(typeof state !== "undefined" ? state?.account?.id || "" : "");
    } catch {
      return "";
    }
  }

  async function ensureInitialized() {
    const accountId = currentAccountId();
    if (!accountId || !authToken()) return null;
    if (activeRecord && activeAccountId === accountId && status.ready) return activeRecord;
    if (initializationPromise && activeAccountId === accountId) return initializationPromise;

    activeAccountId = accountId;
    initializationPromise = (async () => {
      const supported = await supportsRequiredCrypto();
      publishStatus({ supported, ready: false, accountId, lastError: "" });
      if (!supported) throw new Error("This browser does not support X25519 and Ed25519 Web Crypto.");

      const currentDeviceId = deviceId();
      const storageKey = `${accountId}:${currentDeviceId}`;
      let record = await storeGet("devices", storageKey);
      if (!record) record = await createDeviceRecord(accountId, currentDeviceId);
      record = await refreshDeviceRecord(record);

      // Prove that the browser can structured-clone non-extractable CryptoKeys.
      const persisted = await storeGet("devices", storageKey);
      if (!persisted?.identityDhPrivate || !persisted?.identitySignPrivate) {
        throw new Error("The browser cannot persist non-extractable E2EE keys.");
      }
      record = persisted;
      await registerDevice(record);
      activeRecord = record;
      publishStatus({
        supported: true,
        ready: true,
        accountId,
        deviceId: currentDeviceId,
        phase: ROLLOUT_PHASE,
        lastError: ""
      });
      return record;
    })().catch((error) => {
      activeRecord = null;
      publishStatus({ ready: false, lastError: String(error?.message || error) });
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

  function attachmentManifest(attachments) {
    return (Array.isArray(attachments) ? attachments : []).slice(0, 8).map((item) => ({
      kind: String(item?.kind || "file").slice(0, 24),
      name: String(item?.name || "").slice(0, 240),
      mime: String(item?.mime || item?.type || "").slice(0, 160),
      size: Math.max(0, Number(item?.size) || 0)
    }));
  }

  function plaintextObject(payload, accountId) {
    return {
      version: 1,
      messageId: String(payload.clientMessageId || ""),
      chatId: String(payload.chatId || ""),
      senderId: accountId,
      text: String(payload.text || payload.message || ""),
      formattedHtml: String(payload.formattedHtml || payload.formatted_html || ""),
      replyToMessageId: String(payload.replyToMessageId || ""),
      forwardedFrom: String(payload.forwardedFrom || ""),
      attachments: attachmentManifest(payload.attachments)
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

  async function trustBundle(accountId, bundle) {
    const key = `${accountId}:${bundle.userId}:${bundle.deviceId}`;
    const fingerprintBytes = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      concatBytes([
        base64UrlToBytes(bundle.identityDhPublic),
        base64UrlToBytes(bundle.identitySignPublic)
      ])
    ));
    const fingerprint = bytesToBase64Url(fingerprintBytes);
    const previous = await storeGet("trust", key);
    if (previous && previous.fingerprint !== fingerprint) {
      throw new Error(`The identity key for device ${bundle.deviceId} changed.`);
    }
    if (!previous) {
      await storePut("trust", {
        key,
        accountId,
        userId: String(bundle.userId || ""),
        deviceId: String(bundle.deviceId || ""),
        fingerprint,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now()
      });
    } else {
      previous.lastSeenAt = Date.now();
      await storePut("trust", previous);
    }
    return fingerprint;
  }

  async function envelopeForBundle(record, bundle, contentKeyBytes, messageId) {
    if (bundle.algorithm !== ALGORITHM) throw new Error("Unsupported recipient E2EE algorithm.");
    if (!await verifySignedPreKey(bundle)) throw new Error("Recipient signed prekey verification failed.");
    await trustBundle(record.accountId, bundle);

    const ephemeral = await hardenedKeyPair("X25519", [], ["deriveBits"]);
    const dhParts = [
      await deriveX25519(record.identityDhPrivate, bundle.signedPreKey.publicKey),
      await deriveX25519(ephemeral.privateKey, bundle.identityDhPublic),
      await deriveX25519(ephemeral.privateKey, bundle.signedPreKey.publicKey)
    ];
    if (bundle.oneTimePreKey?.publicKey) {
      dhParts.push(await deriveX25519(ephemeral.privateKey, bundle.oneTimePreKey.publicKey));
    }

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

  async function buildShadowPayload(payload, record) {
    const chatId = String(payload.chatId || "");
    const messageId = String(payload.clientMessageId || "");
    if (!chatId || !messageId || !activePrivateChat(chatId)) return null;

    const claimed = await apiJson("/api/e2ee/bundles/claim", {
      body: { chatId, senderDeviceId: record.deviceId }
    });
    const bundles = Array.isArray(claimed.bundles) ? claimed.bundles : [];
    if (!bundles.length) return null;

    const plaintext = plaintextObject(payload, record.accountId);
    const plaintextBytes = encoder.encode(JSON.stringify(plaintext));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", plaintextBytes));
    const contentKeyBytes = randomBytes(32);
    const contentKey = await crypto.subtle.importKey("raw", contentKeyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
    const iv = randomBytes(12);
    const aad = `${ALGORITHM}|content|${chatId}|${messageId}|${record.deviceId}`;
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
      contentKey,
      plaintextBytes
    ));

    const envelopes = [];
    for (const bundle of bundles) {
      envelopes.push(await envelopeForBundle(record, bundle, contentKeyBytes, messageId));
    }
    if (envelopes.length !== bundles.length) throw new Error("Not every chat device received an E2EE envelope.");

    return {
      version: 1,
      mode: ROLLOUT_PHASE,
      messageId,
      chatId,
      senderDeviceId: record.deviceId,
      ciphertext: bytesToBase64Url(ciphertext),
      iv: bytesToBase64Url(iv),
      aad,
      plaintextDigest: bytesToBase64Url(digest),
      envelopes
    };
  }

  async function prepareMessageRequest(input, init, meta) {
    if (meta.pathname !== "/api/message" || meta.method !== "POST") return { input, init };
    if (typeof init?.body !== "string") return { input, init };
    let payload;
    try {
      payload = JSON.parse(init.body);
    } catch {
      return { input, init };
    }
    if (!payload || payload.e2ee || !activePrivateChat(payload.chatId)) return { input, init };

    const record = await ensureInitialized();
    if (!record) return { input, init };
    try {
      const encrypted = await buildShadowPayload(payload, record);
      if (!encrypted) return { input, init };
      const headers = new Headers(init.headers || {});
      headers.set("Content-Type", "application/json");
      return {
        input,
        init: { ...init, headers, body: JSON.stringify({ ...payload, e2ee: encrypted }) }
      };
    } catch (error) {
      publishStatus({ lastError: String(error?.message || error) });
      // Shadow rollout must never prevent a legacy message from being sent.
      return { input, init };
    }
  }

  async function unwrapContentKey(record, e2ee, envelope) {
    const signed = (record.signedPreKeys || []).find((item) => item.id === envelope.signedPreKeyId);
    if (!signed) throw new Error("The required signed prekey is no longer on this device.");
    const dhParts = [
      await deriveX25519(signed.privateKey, envelope.senderIdentityKey),
      await deriveX25519(record.identityDhPrivate, envelope.ephemeralKey),
      await deriveX25519(signed.privateKey, envelope.ephemeralKey)
    ];
    if (envelope.oneTimePreKeyId) {
      const prekey = (record.oneTimePreKeys || []).find((item) => item.id === envelope.oneTimePreKeyId);
      if (!prekey) throw new Error("The required one-time prekey is no longer on this device.");
      dhParts.push(await deriveX25519(prekey.privateKey, envelope.ephemeralKey));
    }

    const salt = base64UrlToBytes(envelope.salt);
    const info = encoder.encode(`${ALGORITHM}|envelope|${String(e2ee.aad || "").split("|").at(-2) || ""}|${record.deviceId}`);
    // The message id is the penultimate item in the content AAD.
    const aadParts = String(e2ee.aad || "").split("|");
    const messageId = aadParts.length >= 2 ? aadParts[aadParts.length - 2] : "";
    const exactInfo = encoder.encode(`${ALGORITHM}|envelope|${messageId}|${record.deviceId}`);
    const hkdfMaterial = await crypto.subtle.importKey("raw", concatBytes(dhParts), "HKDF", false, ["deriveKey"]);
    const wrapKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: exactInfo },
      hkdfMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(envelope.iv), additionalData: exactInfo },
      wrapKey,
      base64UrlToBytes(envelope.ciphertext)
    ));
  }

  async function decryptMessage(message, record) {
    const e2ee = message?.e2ee;
    if (!e2ee || Number(e2ee.version) !== 1 || !Array.isArray(e2ee.envelopes)) return message;
    const envelope = e2ee.envelopes.find((item) => String(item?.deviceId || "") === record.deviceId);
    if (!envelope) return { ...message, e2eeVerified: false, e2eeUnavailable: true };

    try {
      const contentKeyBytes = await unwrapContentKey(record, e2ee, envelope);
      const contentKey = await crypto.subtle.importKey("raw", contentKeyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
      const plaintextBytes = new Uint8Array(await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64UrlToBytes(e2ee.iv),
          additionalData: encoder.encode(String(e2ee.aad || ""))
        },
        contentKey,
        base64UrlToBytes(e2ee.ciphertext)
      ));
      const digest = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", plaintextBytes)));
      if (digest !== String(e2ee.plaintextDigest || "")) throw new Error("E2EE plaintext digest mismatch.");
      const plaintext = JSON.parse(decoder.decode(plaintextBytes));

      if (e2ee.mode === "shadow") {
        const sameText = String(message.text || "") === String(plaintext.text || "");
        const sameReply = String(message.replyToMessageId || "") === String(plaintext.replyToMessageId || "");
        if (!sameText || !sameReply) throw new Error("The E2EE shadow copy does not match the server copy.");
      }

      const result = { ...message, e2eeVerified: true, e2eeUnavailable: false };
      if (e2ee.mode === "encrypted") {
        result.text = String(plaintext.text || "");
        result.formattedHtml = String(plaintext.formattedHtml || "");
        result.replyToMessageId = String(plaintext.replyToMessageId || "") || null;
      }
      publishStatus({ verifiedMessages: status.verifiedMessages + 1, lastError: "" });
      return result;
    } catch (error) {
      publishStatus({
        verificationFailures: status.verificationFailures + 1,
        lastError: String(error?.message || error)
      });
      return { ...message, e2eeVerified: false, e2eeUnavailable: false };
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

  window.fetch = async function yachatE2EEFetch(input, init = {}) {
    const meta = requestMeta(input, init);
    const prepared = meta.sameOrigin ? await prepareMessageRequest(input, init, meta) : { input, init };
    const response = await nativeFetch(prepared.input, prepared.init);
    if (!shouldInspectResponse(meta, response)) return response;

    try {
      const payload = await response.clone().json();
      const decrypted = await decryptResponsePayload(payload);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("X-YaChat-E2EE-Runtime", ROLLOUT_PHASE);
      return new Response(JSON.stringify(decrypted), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch {
      return response;
    }
  };

  async function periodicInitialization() {
    const accountId = currentAccountId();
    if (!accountId || !authToken()) return;
    if (accountId !== activeAccountId || !status.ready) {
      const now = Date.now();
      if (now - lastInitializationAttempt < 5000) return;
      lastInitializationAttempt = now;
      await ensureInitialized();
    }
  }

  publishStatus({ supported: false, ready: false, phase: ROLLOUT_PHASE });
  queueMicrotask(() => periodicInitialization());
  window.setInterval(periodicInitialization, 4000);
})();

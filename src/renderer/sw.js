const YACHAT_SW_VERSION = "92";
const RECENT_PUSH_TTL_MS = 10 * 60 * 1000;
const E2EE_DB_NAME = "yachat-e2ee-v1";
const PUSH_PREVIEW_PLAINTEXT_BYTES = 1024;
const PUSH_PREVIEW_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const recentPushTags = new Map();
const previewEncoder = new TextEncoder();
const previewDecoder = new TextDecoder();

function normalizeAppTarget(value) {
  const source = String(value || "").trim();
  if (/^https?:\/\//i.test(source)) {
    return source;
  }
  if (!source || source === "/") {
    return "/web";
  }
  if (source === "/web" || source.startsWith("/web/") || source.startsWith("/web?")) {
    return source;
  }
  return `/web${source.startsWith("/") ? source : `/${source}`}`;
}

function pruneRecentPushTags(now = Date.now()) {
  recentPushTags.forEach((timestamp, tag) => {
    if (now - timestamp > RECENT_PUSH_TTL_MS) {
      recentPushTags.delete(tag);
    }
  });
}

function stableNotificationTag(payload, targetUrl, title, body) {
  const supplied = String(payload?.tag || "").trim();
  if (supplied) return supplied;
  return `yachat:${targetUrl}:${title}:${body}`.slice(0, 240);
}

function base64UrlToBytes(value) {
  const source = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = source + "=".repeat((4 - source.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function expectedPushPreviewAad(preview) {
  const version = Number(preview?.version || 0);
  if (version >= 2) {
    return (
      `yachat-x3dh-v1|push-descriptor|v2|${preview.contextId}|${preview.senderDeviceId}|`
      + `${preview.deviceId}|${preview.recipientPushPreviewPublic}`
    );
  }
  return (
    `yachat-x3dh-v1|push-preview|v1|${preview.chatId}|${preview.messageId}|`
    + `${preview.senderUserId}|${preview.senderDeviceId}|${preview.userId}|${preview.deviceId}|`
    + `${preview.recipientPushPreviewPublic}`
  );
}

function pushPreviewSignatureInput(preview) {
  return previewEncoder.encode([
    preview.aad,
    preview.senderIdentitySignPublic,
    preview.ephemeralKey,
    preview.salt,
    preview.iv,
    preview.ciphertext
  ].join("|"));
}

async function e2eeStoreGet(storeName, key) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(E2EE_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open the E2EE database."));
  });
  try {
    if (!database.objectStoreNames.contains(storeName)) return null;
    return await new Promise((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Unable to read the E2EE database."));
    });
  } finally {
    database.close();
  }
}

async function pinPushPreviewIdentity(preview) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(E2EE_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open the E2EE database."));
  });
  try {
    if (!database.objectStoreNames.contains("pushPreviewTrust")) {
      throw new Error("Push-preview trust storage is unavailable.");
    }
    const key = Number(preview.version || 0) >= 2
      ? `device:${preview.senderDeviceId}`
      : `${preview.senderUserId}:${preview.senderDeviceId}`;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("pushPreviewTrust", "readwrite");
      const store = transaction.objectStore("pushPreviewTrust");
      let rejected = false;
      const request = store.get(key);
      request.onsuccess = () => {
        const existing = request.result || null;
        if (existing && existing.identitySignPublic !== preview.senderIdentitySignPublic) {
          rejected = true;
          transaction.abort();
          reject(new Error("The push-preview sender identity changed."));
          return;
        }
        store.put({
          key,
          senderUserId: preview.senderUserId,
          senderDeviceId: preview.senderDeviceId,
          identitySignPublic: preview.senderIdentitySignPublic,
          firstSeenAt: Number(existing?.firstSeenAt || Date.now()),
          lastSeenAt: Date.now()
        });
      };
      request.onerror = () => {
        rejected = true;
        reject(request.error || new Error("Unable to read push-preview trust."));
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        if (!rejected) reject(transaction.error || new Error("Unable to persist push-preview trust."));
      };
      transaction.onabort = () => {
        if (!rejected) reject(transaction.error || new Error("Push-preview trust transaction aborted."));
      };
    });
  } finally {
    database.close();
  }
}

async function decryptPushPreview(preview) {
  if (!preview || ![1, 2].includes(Number(preview.version || 0))) {
    throw new Error("Unsupported encrypted push preview.");
  }
  const keyRecord = await e2eeStoreGet("pushPreviewKeys", String(preview.deviceId || ""));
  if (
    !keyRecord?.privateJwk?.d
    || keyRecord.publicKey !== preview.recipientPushPreviewPublic
    || keyRecord.deviceId !== preview.deviceId
  ) {
    throw new Error("This notification belongs to another E2EE device.");
  }
  if (String(preview.aad || "") !== expectedPushPreviewAad(preview)) {
    throw new Error("The encrypted push-preview context was modified.");
  }
  const trustedBundle = Number(preview.version || 0) === 1
    ? await e2eeStoreGet(
        "trust",
        `${preview.userId}:${preview.senderUserId}:${preview.senderDeviceId}`
      )
    : null;
  if (
    trustedBundle?.identitySignPublic
    && trustedBundle.identitySignPublic !== preview.senderIdentitySignPublic
  ) {
    throw new Error("The push-preview identity does not match the trusted E2EE bundle.");
  }

  const senderSigningKey = await crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(preview.senderIdentitySignPublic),
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  const validSignature = await crypto.subtle.verify(
    "Ed25519",
    senderSigningKey,
    base64UrlToBytes(preview.signature),
    pushPreviewSignatureInput(preview)
  );
  if (!validSignature) throw new Error("The encrypted push-preview signature is invalid.");

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    keyRecord.privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const ephemeralKey = await crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(preview.ephemeralKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: ephemeralKey },
    privateKey,
    256
  ));
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: base64UrlToBytes(preview.salt),
      info: previewEncoder.encode(preview.aad)
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(preview.iv),
      additionalData: previewEncoder.encode(preview.aad)
    },
    key,
    base64UrlToBytes(preview.ciphertext)
  ));
  if (plaintext.byteLength !== PUSH_PREVIEW_PLAINTEXT_BYTES) {
    throw new Error("The encrypted push-preview size is invalid.");
  }
  const length = (plaintext[0] << 8) | plaintext[1];
  if (length <= 0 || length > plaintext.byteLength - 2) {
    throw new Error("The encrypted push-preview payload is invalid.");
  }
  const decoded = JSON.parse(previewDecoder.decode(plaintext.subarray(2, 2 + length)));
  const createdAt = Number(decoded.createdAt || 0);
  if (
    Number(decoded.version || 0) !== Number(preview.version || 0)
    || (
      Number(preview.version || 0) === 1
      && String(decoded.messageId || "") !== String(preview.messageId || "")
    )
    || (
      Number(preview.version || 0) >= 2
      && String(decoded.contextId || "") !== String(preview.contextId || "")
    )
    || !createdAt
    || createdAt > Date.now() + 10 * 60 * 1000
    || Date.now() - createdAt > PUSH_PREVIEW_MAX_AGE_MS
  ) {
    throw new Error("The encrypted push-preview payload expired or has the wrong context.");
  }
  const body = String(decoded.body || "").trim();
  if (!body) throw new Error("The encrypted push-preview body is empty.");
  await pinPushPreviewIdentity(preview);
  if (Number(preview.version || 0) === 1) return body.slice(0, 300);
  return {
    title: String(decoded.title || "ЯЧат").slice(0, 120),
    body: body.slice(0, 300),
    url: String(decoded.url || "/web").slice(0, 300),
    tag: String(decoded.tag || `message:${decoded.messageId || "sealed"}`).slice(0, 240),
    timestamp: Number(decoded.clientCreatedAt || createdAt)
  };
}

async function resolvePushDescriptor(payload) {
  if (payload?.e2eePreview) {
    try {
      const decrypted = await decryptPushPreview(payload.e2eePreview);
      if (typeof decrypted === "string") {
        return { title: payload.title || "ЯЧат", body: decrypted, url: payload.url || "/web", tag: payload.tag || "" };
      }
      return decrypted;
    } catch {
      return { title: "ЯЧат", body: "Новое сообщение", url: "/web", tag: "" };
    }
  }
  return {
    title: String(payload?.title || "ЯЧат"),
    body: String(payload?.body || "Новое сообщение"),
    url: String(payload?.url || "/web"),
    tag: String(payload?.tag || "")
  };
}

async function showPushNotification(payload = {}) {
  const descriptor = await resolvePushDescriptor(payload);
  const targetUrl = normalizeAppTarget(descriptor.url);
  const title = descriptor.title || "ЯЧат";
  const body = descriptor.body || "Новое сообщение";
  const tag = descriptor.tag || stableNotificationTag(payload, targetUrl, title, body);
  const now = Date.now();

  pruneRecentPushTags(now);
  if (recentPushTags.has(tag)) {
    return;
  }

  const visible = await self.registration.getNotifications({ tag }).catch(() => []);
  if (visible.length > 0) {
    recentPushTags.set(tag, now);
    return;
  }

  recentPushTags.set(tag, now);
  const options = {
    body,
    icon: `/assets/yachat-brand-180.png?v=${YACHAT_SW_VERSION}`,
    badge: `/assets/yachat-brand-notification.png?v=${YACHAT_SW_VERSION}`,
    tag,
    renotify: false,
    silent: false,
    timestamp: Number(descriptor.timestamp || now),
    lang: "ru",
    dir: "auto",
    data: {
      url: targetUrl,
      tag,
      version: YACHAT_SW_VERSION
    }
  };

  await self.registration.showNotification(title, options);
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {
      title: "ЯЧат",
      body: event.data ? event.data.text() : "Новое сообщение"
    };
  }

  event.waitUntil(showPushNotification(payload));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(normalizeAppTarget(event.notification.data?.url), self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const exact = windows.find((client) => client.url === url);
    const existing = exact || windows.find((client) => {
      try {
        const current = new URL(client.url);
        return current.origin === self.location.origin && current.pathname.startsWith("/web");
      } catch {
        return false;
      }
    });

    if (existing) {
      if ("navigate" in existing && existing.url !== url) {
        await existing.navigate(url);
      }
      await existing.focus();
      return;
    }

    await clients.openWindow(url);
  })());
});

(() => {
  "use strict";

  if (self.__yachatPersistentPushDedupInstalled) return;
  self.__yachatPersistentPushDedupInstalled = true;

  const DB_NAME = "yachat-push-state-v1";
  const STORE_NAME = "shown-notifications";
  const DB_VERSION = 1;
  const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_NOTIFICATION_AGE_MS = 2 * 24 * 60 * 60 * 1000;
  const FUTURE_SKEW_MS = 10 * 60 * 1000;
  const pushEnvelopeByTag = new Map();

  function validEnvelope(value, now = Date.now()) {
    const sentAt = Number(value?.sentAt || 0);
    const expiresAt = Number(value?.expiresAt || 0);
    return (
      Number.isFinite(sentAt)
      && Number.isFinite(expiresAt)
      && sentAt > 0
      && expiresAt >= sentAt
      && sentAt <= now + FUTURE_SKEW_MS
      && now <= expiresAt
      && now - sentAt <= MAX_NOTIFICATION_AGE_MS
    );
  }

  self.addEventListener("push", (event) => {
    try {
      const payload = event.data ? event.data.json() : null;
      const tag = String(payload?.tag || "").trim().slice(0, 240);
      if (!tag) return;
      pushEnvelopeByTag.set(tag, {
        sentAt: Number(payload?.sentAt || 0),
        expiresAt: Number(payload?.expiresAt || 0)
      });
    } catch {
      // Untimestamped or malformed legacy pushes are rejected by showNotification below.
    }
  });

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "tag" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Unable to open push state."));
    });
  }

  async function withStore(mode, callback) {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        let value;
        try {
          value = callback(store, transaction);
        } catch (error) {
          reject(error);
          return;
        }
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = () => reject(transaction.error || new Error("Push state transaction failed."));
        transaction.onabort = () => reject(transaction.error || new Error("Push state transaction aborted."));
      });
    } finally {
      database.close();
    }
  }

  async function prune(now) {
    await withStore("readwrite", (store) => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (now - Number(cursor.value?.shownAt || 0) > RETENTION_MS) {
          cursor.delete();
        }
        cursor.continue();
      };
    }).catch(() => {});
  }

  async function claim(tag, sentAt) {
    const normalizedTag = String(tag || "").trim().slice(0, 240);
    if (!normalizedTag) return false;
    const now = Date.now();
    if (
      !Number.isFinite(sentAt)
      || sentAt <= 0
      || sentAt > now + FUTURE_SKEW_MS
      || now - sentAt > MAX_NOTIFICATION_AGE_MS
    ) {
      return false;
    }

    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        let claimed = false;
        const request = store.get(normalizedTag);
        request.onsuccess = () => {
          if (request.result) return;
          claimed = true;
          store.put({
            tag: normalizedTag,
            shownAt: now,
            messageTimestamp: sentAt
          });
        };
        request.onerror = () => reject(request.error || new Error("Unable to read push state."));
        transaction.oncomplete = () => resolve(claimed);
        transaction.onerror = () => reject(transaction.error || new Error("Unable to persist push state."));
        transaction.onabort = () => reject(transaction.error || new Error("Push state transaction aborted."));
      });
    } finally {
      database.close();
    }
  }

  async function release(tag) {
    const normalizedTag = String(tag || "").trim().slice(0, 240);
    if (!normalizedTag) return;
    await withStore("readwrite", (store) => store.delete(normalizedTag)).catch(() => {});
  }

  const prototype = self.ServiceWorkerRegistration?.prototype;
  const originalShowNotification = prototype?.showNotification;
  if (typeof originalShowNotification !== "function") return;

  prototype.showNotification = async function persistentShowNotification(title, options = {}) {
    const tag = String(options?.tag || "").trim().slice(0, 240);
    const envelope = pushEnvelopeByTag.get(tag);
    pushEnvelopeByTag.delete(tag);
    if (!validEnvelope(envelope)) return undefined;

    const sentAt = Number(envelope.sentAt);
    const allowed = await claim(tag, sentAt).catch(() => false);
    if (!allowed) return undefined;

    try {
      const result = await originalShowNotification.call(this, title, {
        ...options,
        data: {
          ...(options?.data || {}),
          sentAt,
          expiresAt: Number(envelope.expiresAt)
        }
      });
      void prune(Date.now());
      return result;
    } catch (error) {
      await release(tag);
      throw error;
    }
  };
})();

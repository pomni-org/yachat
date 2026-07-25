const YACHAT_SW_VERSION = "91";
const RECENT_PUSH_TTL_MS = 10 * 60 * 1000;
const recentPushTags = new Map();

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

async function showPushNotification(payload = {}) {
  const targetUrl = normalizeAppTarget(payload.url);
  const title = payload.title || "ЯЧат";
  const body = payload.body || "Новое сообщение";
  const tag = stableNotificationTag(payload, targetUrl, title, body);
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
    timestamp: now,
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

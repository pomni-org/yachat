const YACHAT_SW_VERSION = "87";

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

  const targetUrl = normalizeAppTarget(payload.url);
  const title = payload.title || "ЯЧат";
  const options = {
    body: payload.body || "Новое сообщение",
    icon: `/assets/yachat-brand-180.png?v=${YACHAT_SW_VERSION}`,
    badge: `/assets/yachat-brand-notification.png?v=${YACHAT_SW_VERSION}`,
    tag: payload.tag || `yachat:${targetUrl}:${Date.now()}`,
    renotify: true,
    silent: false,
    timestamp: Date.now(),
    lang: "ru",
    dir: "auto",
    data: {
      url: targetUrl,
      version: YACHAT_SW_VERSION
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
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

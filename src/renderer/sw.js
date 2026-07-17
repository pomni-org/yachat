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

  const targetUrl = payload.url || "/";
  const title = payload.title || "ЯЧат";
  const options = {
    body: payload.body || "Новое сообщение",
    icon: "/assets/yachat-brand-180.png?v=24",
    badge: "/assets/yachat-brand-notification.png?v=24",
    tag: payload.tag || `yachat:${targetUrl}`,
    renotify: true,
    timestamp: Date.now(),
    data: {
      url: targetUrl
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const exact = windows.find((client) => client.url === url);
    const existing = exact || windows.find((client) => client.url.startsWith(self.location.origin));

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
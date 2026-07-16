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

  const title = payload.title || "ЯЧат";
  const options = {
    body: payload.body || "Новое сообщение",
    icon: "/assets/yachat-brand-192.png?v=5",
    badge: "/assets/yachat-brand-notification.png?v=5",
    data: {
      url: payload.url || "/"
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));

    if (existing) {
      await existing.focus();
      existing.navigate(url);
      return;
    }

    await clients.openWindow(url);
  })());
});

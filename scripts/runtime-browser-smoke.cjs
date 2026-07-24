const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const RESULT_ID = "runtime-smoke-result";
const TEST_TIMEOUT_MS = 22000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  }

  for (const command of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const result = spawnSync("which", [command], { encoding: "utf8" });
    const resolved = String(result.stdout || "").trim();
    if (result.status === 0 && resolved) return resolved;
  }

  throw new Error("[browser-smoke] Chrome/Chromium was not found on the test runner.");
}

function smokeData() {
  const account = {
    id: "smoke-user",
    username: "smoke_user",
    displayName: "Smoke User",
    bio: "Runtime smoke account",
    avatarDataUrl: "",
    avatarAccent: "#471AFF",
    createdAt: "2026-07-24T00:00:00.000Z"
  };
  const peer = {
    id: "smoke-peer",
    username: "smoke_peer",
    displayName: "Smoke Peer",
    avatarDataUrl: "",
    online: true,
    presence: "online"
  };
  const chat = {
    id: "private-smoke",
    kind: "private",
    title: "Smoke Peer",
    subtitle: "В сети",
    description: "Browser stability test",
    participantIds: [account.id, peer.id],
    participantProfiles: {
      [account.id]: account,
      [peer.id]: peer
    },
    canSend: true,
    unread: 1,
    lastMessage: "Smoke message 79",
    lastAt: "2026-07-24T00:01:19.000Z",
    createdAt: "2026-07-24T00:00:00.000Z"
  };
  const messages = Array.from({ length: 80 }, (_, index) => ({
    id: `smoke-message-${index}`,
    chatId: chat.id,
    author: index % 3 === 0 ? "user" : "peer",
    senderId: index % 3 === 0 ? account.id : peer.id,
    text: `Smoke message ${index} ${"x".repeat(900)}`,
    createdAt: new Date(Date.parse("2026-07-24T00:00:00.000Z") + index * 1000).toISOString(),
    attachments: [],
    deliveryStatus: "sent"
  }));
  return {
    account,
    chats: [chat],
    messages,
    settings: {
      theme: "dark",
      themeSource: "manual",
      language: "ru",
      country: "RU",
      countryCode: "+7"
    }
  };
}

const data = smokeData();

function preAppScript(profile) {
  return `<script>
    window.__smokeProfile = ${JSON.stringify(profile)};
    window.__smokeStage = "pre-app";
    window.__smokeRequests = [];
    window.__smokeErrors = [];
    window.__smokeHeartbeat = 0;
    localStorage.setItem("yachat-http-auth-token", "smoke-token");
    window.setInterval(() => { window.__smokeHeartbeat += 1; }, 100);
    window.addEventListener("error", (event) => {
      window.__smokeErrors.push(String(event.error?.stack || event.message || "error"));
    });
    window.addEventListener("unhandledrejection", (event) => {
      window.__smokeErrors.push(String(event.reason?.stack || event.reason || "rejection"));
    });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input?.url || String(input || "");
      window.__smokeRequests.push({ url, at: performance.now() });
      return nativeFetch(input, init);
    };
  </script>`;
}

function postAppScript(profile) {
  return `<script>
    (() => {
      const profile = ${JSON.stringify(profile)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (test, timeout = 8000) => {
        const started = performance.now();
        while (performance.now() - started < timeout) {
          if (test()) return true;
          await sleep(50);
        }
        return false;
      };
      const finish = (kind, payload) => {
        const node = document.createElement("pre");
        node.id = ${JSON.stringify(RESULT_ID)};
        node.textContent = "RUNTIME_SMOKE_" + kind + ":" + JSON.stringify({ profile, ...payload });
        document.body.append(node);
        document.title = "RUNTIME_SMOKE_" + kind;
        window.__smokeStage = kind === "PASS" ? "complete" : "failed";
      };

      (async () => {
        window.__smokeStage = "waiting-for-messenger";
        const loaded = await waitFor(() => (
          document.body.classList.contains("messenger-mode")
          && !document.body.classList.contains("app-booting")
          && document.querySelector("[data-messenger]")?.hidden === false
          && document.querySelectorAll("[data-chat-id]").length > 0
          && document.querySelectorAll("[data-message-id]").length >= 80
        ));
        if (!loaded) {
          finish("FAIL", {
            message: "messenger did not finish loading",
            bodyClass: document.body.className,
            chats: document.querySelectorAll("[data-chat-id]").length,
            messages: document.querySelectorAll("[data-message-id]").length,
            errors: window.__smokeErrors
          });
          return;
        }

        window.__smokeStage = "opening-settings";
        document.querySelector('[data-rail="settings"]')?.click();
        await sleep(250);
        const settingsOpened = document.querySelector("[data-side-panel]")?.hidden === false;

        window.__smokeStage = "opening-message-menu";
        document.querySelector('[data-action="close-panel"]')?.click();
        document.querySelector('[data-rail="all"]')?.click();
        document.querySelector("[data-chat-id]")?.click();
        await sleep(350);
        const firstMessage = document.querySelector("[data-message-id]");
        firstMessage?.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 220
        }));
        await sleep(220);
        const menuOpened = Boolean(document.querySelector("[data-message-menu]:not([hidden])"));
        document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        window.__smokeStage = "polling";
        const heartbeatBeforePolling = window.__smokeHeartbeat;
        await sleep(6800);

        window.__smokeStage = "checking-results";
        const requestUrls = window.__smokeRequests.map((item) => item.url);
        const fullSnapshots = requestUrls.filter((url) => /\\/api\\/messenger(?:\\?|$)/.test(url));
        const compactChatPolls = requestUrls.filter((url) => url.includes("/api/chats/poll"));
        const messagePolls = requestUrls.filter((url) => url.includes("/api/messages"));
        const presencePolls = requestUrls.filter((url) => url.includes("/api/presence"));
        const heartbeatDelta = window.__smokeHeartbeat - heartbeatBeforePolling;
        const checks = {
          settingsOpened,
          menuOpened,
          runtimeGuard: document.documentElement.dataset.yachatRuntimeGuard || "",
          backgroundDelegated: window.__yachatBackgroundSyncDelegated === true,
          activePollMs: Number(document.documentElement.dataset.yachatActivePollMs || 0),
          fullSnapshots: fullSnapshots.length,
          compactChatPolls: compactChatPolls.length,
          messagePolls: messagePolls.length,
          presencePolls: presencePolls.length,
          totalRequests: requestUrls.length,
          heartbeatDelta,
          errors: window.__smokeErrors
        };

        const problems = [];
        if (!settingsOpened) problems.push("settings menu did not open");
        if (!menuOpened) problems.push("message menu did not open");
        if (checks.runtimeGuard !== "optimized-refresh-v2") problems.push("optimized runtime guard missing");
        if (!checks.backgroundDelegated) problems.push("background sync did not delegate");
        if (checks.activePollMs < 1000) problems.push("polling interval is unsafe");
        if (checks.fullSnapshots !== 0) problems.push("full messenger snapshot polling is active");
        if (checks.messagePolls < 2) problems.push("incremental message polling did not run");
        if (checks.totalRequests > 35) problems.push("too many requests during smoke window");
        if (heartbeatDelta < 35) problems.push("main thread stopped responding");
        if (checks.errors.length) problems.push("browser errors occurred");

        if (problems.length) {
          finish("FAIL", { message: problems.join("; "), ...checks });
          return;
        }

        finish("PASS", checks);
      })().catch((error) => finish("FAIL", {
        message: error.message || String(error),
        stack: error.stack || "",
        errors: window.__smokeErrors
      }));
    })();
  </script>`;
}

function smokeHtml(profile) {
  const html = fs.readFileSync(path.join(publicDir, "web.html"), "utf8");
  const withPreload = html.replace(
    /(<script src="\/app\.js[^>]*><\/script>)/,
    `${preAppScript(profile)}\n$1`
  );
  if (withPreload === html) throw new Error("[browser-smoke] Unable to inject pre-app instrumentation.");
  return withPreload.replace("</body>", `${postAppScript(profile)}\n</body>`);
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ico": "image/x-icon"
  }[extension] || "application/octet-stream";
}

function json(response, payload, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function apiResponse(pathname, response) {
  if (pathname === "/api/bootstrap" || pathname === "/api/messenger") {
    json(response, {
      authenticated: true,
      account: data.account,
      settings: data.settings,
      chats: data.chats,
      messages: data.messages,
      activeChatId: data.chats[0].id,
      routeUser: null
    });
    return;
  }
  if (pathname === "/api/chats/poll" || pathname === "/api/chats") {
    json(response, data.chats.map((chat) => ({ ...chat, unread: 0 })));
    return;
  }
  if (pathname === "/api/messages") {
    json(response, data.messages);
    return;
  }
  if (pathname === "/api/chat/mark-read") {
    json(response, {
      ok: true,
      chats: data.chats.map((chat) => ({ ...chat, unread: 0 })),
      messages: data.messages
    });
    return;
  }
  if (pathname === "/api/settings") {
    json(response, data.settings);
    return;
  }
  if (pathname === "/api/push/public-key") {
    json(response, { enabled: false, publicKey: "" });
    return;
  }
  if (pathname === "/api/presence") {
    json(response, { ok: true, status: "online", typingUsers: [], subscriberCount: 2 });
    return;
  }
  json(response, { ok: true });
}

function createServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      request.resume();
      apiResponse(url.pathname, response);
      return;
    }

    if (url.pathname === "/web" || url.pathname === "/web/") {
      const profile = url.searchParams.get("profile") || "unknown";
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(smokeHtml(profile));
      return;
    }

    const decoded = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const filePath = path.resolve(publicDir, decoded || "index.html");
    if (!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== path.join(publicDir, "index.html")) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeType(filePath),
      "Cache-Control": "no-store"
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
        return;
      }
      const handlers = this.handlers.get(message.method) || [];
      handlers.forEach((handler) => handler(message.params || {}, message.sessionId || null));
    });

    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("CDP socket closed"));
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("Unable to connect to Chrome DevTools")), { once: true });
    });
    return new CdpClient(socket);
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  send(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    this.socket.close();
  }
}

async function launchChrome(chrome, profile, width, height) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `yachat-smoke-${profile}-`));
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    "about:blank"
  ];
  const child = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  let resolveEndpoint;
  let rejectEndpoint;
  const endpoint = new Promise((resolve, reject) => {
    resolveEndpoint = resolve;
    rejectEndpoint = reject;
  });
  const inspectEndpoint = (chunk) => {
    const text = String(chunk);
    stderr += text;
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) resolveEndpoint(match[1]);
  };
  child.stderr.on("data", inspectEndpoint);
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.on("error", rejectEndpoint);
  child.on("close", (code) => {
    if (code !== 0) rejectEndpoint(new Error(`Chrome exited before DevTools was ready (exit ${code})`));
  });

  const webSocketUrl = await withTimeout(endpoint, 10000, "Chrome DevTools startup");
  return {
    child,
    userDataDir,
    webSocketUrl,
    output() {
      return { stdout, stderr };
    }
  };
}

async function inspectPage(client, sessionId) {
  const expression = `(() => ({
    title: document.title,
    result: document.getElementById(${JSON.stringify(RESULT_ID)})?.textContent || "",
    stage: window.__smokeStage || "unknown",
    heartbeat: Number(window.__smokeHeartbeat || 0),
    errors: Array.isArray(window.__smokeErrors) ? window.__smokeErrors.slice(-10) : [],
    requests: Array.isArray(window.__smokeRequests) ? window.__smokeRequests.slice(-50) : [],
    bodyClass: document.body?.className || "",
    chats: document.querySelectorAll("[data-chat-id]").length,
    messages: document.querySelectorAll("[data-message-id]").length,
    messengerHidden: document.querySelector("[data-messenger]")?.hidden,
    runtimeGuard: document.documentElement.dataset.yachatRuntimeGuard || "",
    activePollMs: document.documentElement.dataset.yachatActivePollMs || ""
  }))()`;
  const evaluated = await withTimeout(client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false
  }, sessionId), 1500, "Runtime.evaluate");
  return evaluated.result?.value || null;
}

async function runChrome(chrome, baseUrl, profile, width, height) {
  const launched = await launchChrome(chrome, profile, width, height);
  const networkRequests = [];
  const browserErrors = [];
  let client = null;
  let targetId = null;
  let lastState = null;
  let consecutiveProbeFailures = 0;

  try {
    client = await CdpClient.connect(launched.webSocketUrl);
    const target = await client.send("Target.createTarget", { url: "about:blank" });
    targetId = target.targetId;
    const attached = await client.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.sessionId;

    client.on("Network.requestWillBeSent", (params, eventSessionId) => {
      if (eventSessionId === sessionId) networkRequests.push(params.request?.url || "");
    });
    client.on("Runtime.exceptionThrown", (params, eventSessionId) => {
      if (eventSessionId !== sessionId) return;
      browserErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "Runtime exception");
    });

    await Promise.all([
      client.send("Page.enable", {}, sessionId),
      client.send("Runtime.enable", {}, sessionId),
      client.send("Network.enable", {}, sessionId),
      client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 500
      }, sessionId)
    ]);

    const url = `${baseUrl}/web?local=1&profile=${encodeURIComponent(profile)}`;
    await client.send("Page.navigate", { url }, sessionId);

    const startedAt = Date.now();
    while (Date.now() - startedAt < TEST_TIMEOUT_MS) {
      await sleep(250);
      try {
        lastState = await inspectPage(client, sessionId);
        consecutiveProbeFailures = 0;
      } catch (error) {
        consecutiveProbeFailures += 1;
        if (consecutiveProbeFailures >= 3) {
          throw new Error(`main thread stopped answering CDP probes: ${error.message}`);
        }
        continue;
      }

      if (!lastState?.result) continue;
      if (lastState.result.startsWith("RUNTIME_SMOKE_PASS:")) {
        console.log(`[browser-smoke] ${profile} ${lastState.result}`);
        return;
      }
      throw new Error(lastState.result);
    }

    throw new Error("browser scenario did not finish before the smoke timeout");
  } catch (error) {
    const report = {
      profile,
      message: error.message || String(error),
      lastState,
      networkRequests: networkRequests.slice(-80),
      browserErrors: browserErrors.slice(-20),
      chrome: launched.output()
    };
    throw new Error(`[browser-smoke] ${profile} failed: ${JSON.stringify(report)}`);
  } finally {
    try {
      if (client && targetId) await withTimeout(client.send("Target.closeTarget", { targetId }), 1000, "Target.closeTarget");
    } catch {
      // Chrome is terminated below even if the target stopped responding.
    }
    try {
      client?.close();
    } catch {
      // Ignore socket shutdown errors.
    }
    launched.child.kill("SIGKILL");
    fs.rmSync(launched.userDataDir, { recursive: true, force: true });
  }
}

async function main() {
  if (!fs.existsSync(path.join(publicDir, "web.html"))) {
    throw new Error("[browser-smoke] public/web.html is missing. Run npm run build first.");
  }

  const chrome = findChrome();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await runChrome(chrome, baseUrl, "desktop", 1440, 900);
    await runChrome(chrome, baseUrl, "mobile", 390, 844);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("[browser-smoke] PASS: desktop and mobile stayed responsive through menus and repeated polling.");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

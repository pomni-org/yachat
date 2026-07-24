const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  throw new Error("[browser-final] Chrome/Chromium was not found.");
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
    ".ico": "image/x-icon",
    ".woff2": "font/woff2"
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
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      fs.createReadStream(path.join(publicDir, "web.html")).pipe(response);
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

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result || {});
    });
  }

  send(method, params = {}, timeoutMs = 3000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP socket unavailable for ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 1800) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
      userGesture: true
    }, timeoutMs);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Evaluation failed");
    }
    return result.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch {}
  }
}

async function waitForFile(filePath, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForPageTarget(port, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const targets = await httpJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await delay(100);
  }
  throw new Error("Timed out waiting for CDP page target");
}

const instrumentationSource = `(() => {
  window.__smokeStage = "document-start";
  window.__smokeHeartbeat = 0;
  window.__smokeRequests = [];
  window.__smokeErrors = [];
  try { localStorage.setItem("yachat-http-auth-token", "smoke-token"); } catch {}
  window.setInterval(() => { window.__smokeHeartbeat += 1; }, 100);
  window.addEventListener("error", (event) => {
    window.__smokeErrors.push(String(event.error?.stack || event.message || "error"));
  });
  window.addEventListener("unhandledrejection", (event) => {
    window.__smokeErrors.push(String(event.reason?.stack || event.reason || "rejection"));
  });
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url || String(input || "");
    window.__smokeRequests.push(url);
    return originalFetch(input, init);
  };
})();`;

async function inspect(client) {
  return client.evaluate(`(() => ({
    stage: window.__smokeStage || "missing",
    heartbeat: Number(window.__smokeHeartbeat || 0),
    errors: Array.isArray(window.__smokeErrors) ? window.__smokeErrors.slice(-10) : [],
    requests: Array.isArray(window.__smokeRequests) ? window.__smokeRequests.slice(-60) : [],
    bodyClass: document.body?.className || "",
    messengerHidden: document.querySelector("[data-messenger]")?.hidden,
    panelHidden: document.querySelector("[data-side-panel]")?.hidden,
    menuHidden: document.querySelector("[data-message-menu]")?.hidden,
    chats: document.querySelectorAll("[data-chat-id]").length,
    messages: document.querySelectorAll("[data-message-id]").length,
    runtimeGuard: document.documentElement.dataset.yachatRuntimeGuard || "",
    activePollMs: Number(document.documentElement.dataset.yachatActivePollMs || 0),
    backgroundDelegated: window.__yachatBackgroundSyncDelegated === true
  }))()`);
}

async function waitUntilLoaded(client) {
  const started = Date.now();
  let lastState = null;
  let probeFailures = 0;
  while (Date.now() - started < 10000) {
    await delay(200);
    try {
      lastState = await inspect(client);
      probeFailures = 0;
    } catch (error) {
      probeFailures += 1;
      if (probeFailures >= 3) {
        throw new Error(`main thread became unresponsive during boot: ${error.message}; lastState=${JSON.stringify(lastState)}`);
      }
      continue;
    }

    if (lastState.errors.length) {
      throw new Error(`browser errors during boot: ${JSON.stringify(lastState)}`);
    }
    if (
      lastState.bodyClass.includes("messenger-mode")
      && !lastState.bodyClass.includes("app-booting")
      && lastState.messengerHidden === false
      && lastState.chats > 0
      && lastState.messages >= 80
    ) {
      return lastState;
    }
  }
  throw new Error(`messenger did not finish loading: ${JSON.stringify(lastState)}`);
}

async function runProfile(chrome, baseUrl, profile, width, height, mobile) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `yachat-final-${profile}-`));
  const stderr = [];
  const chromeProcess = spawn(chrome, [
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
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  chromeProcess.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  let client = null;
  let lastState = null;
  try {
    const activePortFile = path.join(userDataDir, "DevToolsActivePort");
    await waitForFile(activePortFile);
    const [portLine] = fs.readFileSync(activePortFile, "utf8").trim().split(/\r?\n/);
    const target = await waitForPageTarget(Number(portLine));
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: instrumentationSource });
    await client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: mobile ? 2 : 1,
      mobile,
      screenWidth: width,
      screenHeight: height
    });
    await client.send("Page.navigate", {
      url: `${baseUrl}/web?local=1&profile=${encodeURIComponent(profile)}`
    });

    lastState = await waitUntilLoaded(client);
    const heartbeatStart = lastState.heartbeat;

    const settingsButtonFound = await client.evaluate(`(() => {
      window.__smokeStage = "settings";
      const button = document.querySelector('[data-rail="settings"]');
      button?.click();
      return Boolean(button);
    })()`);
    await delay(300);
    const panelVisible = await client.evaluate(`document.querySelector("[data-side-panel]")?.hidden === false`);

    await client.evaluate(`(() => {
      window.__smokeStage = "chat";
      document.querySelector('[data-action="close-panel"]')?.click();
      document.querySelector('[data-rail="all"]')?.click();
      document.querySelector("[data-chat-id]")?.click();
      return true;
    })()`);
    await delay(350);

    const messageMenuTriggered = await client.evaluate(`(() => {
      window.__smokeStage = "message-menu";
      const message = document.querySelector("[data-message-id]");
      if (!message) return false;
      message.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 220
      }));
      return true;
    })()`);
    await delay(250);
    const menuVisible = await client.evaluate(`Boolean(document.querySelector("[data-message-menu]:not([hidden])"))`);
    await client.evaluate(`document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }))`);

    await client.evaluate(`window.__smokeStage = "polling"`);
    const heartbeatSamples = [];
    for (let index = 0; index < 7; index += 1) {
      await delay(1000);
      try {
        lastState = await inspect(client);
      } catch (error) {
        throw new Error(`main thread became unresponsive during polling sample ${index + 1}: ${error.message}; lastState=${JSON.stringify(lastState)}`);
      }
      heartbeatSamples.push(lastState.heartbeat);
    }

    const metrics = await client.evaluate(`(() => {
      const requestUrls = window.__smokeRequests || [];
      return {
        runtimeGuard: document.documentElement.dataset.yachatRuntimeGuard || "",
        backgroundDelegated: window.__yachatBackgroundSyncDelegated === true,
        activePollMs: Number(document.documentElement.dataset.yachatActivePollMs || 0),
        fullSnapshots: requestUrls.filter((url) => /\\/api\\/messenger(?:\\?|$)/.test(url)).length,
        compactChatPolls: requestUrls.filter((url) => url.includes("/api/chats/poll")).length,
        messagePolls: requestUrls.filter((url) => url.includes("/api/messages")).length,
        presencePolls: requestUrls.filter((url) => url.includes("/api/presence")).length,
        totalRequests: requestUrls.length,
        heartbeat: Number(window.__smokeHeartbeat || 0),
        errors: window.__smokeErrors || [],
        chats: document.querySelectorAll("[data-chat-id]").length,
        messages: document.querySelectorAll("[data-message-id]").length
      };
    })()`);
    metrics.heartbeatDelta = metrics.heartbeat - heartbeatStart;
    metrics.heartbeatSamples = heartbeatSamples;
    metrics.settingsButtonFound = Boolean(settingsButtonFound);
    metrics.panelVisible = Boolean(panelVisible);
    metrics.messageMenuTriggered = Boolean(messageMenuTriggered);
    metrics.menuVisible = Boolean(menuVisible);

    const problems = [];
    if (!metrics.settingsButtonFound || !metrics.panelVisible) problems.push("settings menu did not open");
    if (!metrics.messageMenuTriggered || !metrics.menuVisible) problems.push("message menu did not open");
    if (metrics.runtimeGuard !== "optimized-refresh-v2") problems.push("optimized runtime guard missing");
    if (!metrics.backgroundDelegated) problems.push("background sync did not delegate");
    if (metrics.activePollMs < 1000) problems.push("poll interval below 1000ms");
    if (metrics.fullSnapshots !== 0) problems.push("full messenger snapshot polling is active");
    if (metrics.messagePolls < 2) problems.push("incremental message polling did not run");
    if (metrics.totalRequests > 35) problems.push("too many requests during smoke window");
    if (metrics.heartbeatDelta < 45) problems.push("main thread heartbeat stalled");
    if (heartbeatSamples.some((value, index) => index > 0 && value <= heartbeatSamples[index - 1])) {
      problems.push("heartbeat stopped between polling samples");
    }
    if (metrics.errors.length) problems.push("browser errors occurred");
    if (metrics.chats < 1 || metrics.messages < 80) problems.push("chat content disappeared during polling");

    if (problems.length) {
      throw new Error(`${problems.join("; ")} ${JSON.stringify(metrics)}`);
    }

    console.log(`[browser-final] ${profile} PASS ${JSON.stringify(metrics)}`);
    return metrics;
  } catch (error) {
    throw new Error(`[browser-final] ${profile} failed: ${error.message}\nChrome stderr:\n${stderr.join("").slice(-1800)}`);
  } finally {
    client?.close();
    chromeProcess.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => chromeProcess.once("close", resolve)),
      delay(1200)
    ]);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function main() {
  if (!fs.existsSync(path.join(publicDir, "web.html"))) {
    throw new Error("[browser-final] public/web.html is missing. Run npm run build first.");
  }

  const chrome = findChrome();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const desktop = await runProfile(chrome, baseUrl, "desktop", 1440, 900, false);
    const mobile = await runProfile(chrome, baseUrl, "mobile", 390, 844, true);
    console.log(`[browser-final] PASS ${JSON.stringify({ desktop, mobile })}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

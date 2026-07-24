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
  throw new Error("[browser-cdp-smoke] Chrome/Chromium was not found.");
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
  const settings = {
    theme: "dark",
    themeSource: "manual",
    language: "ru",
    country: "RU",
    countryCode: "+7"
  };
  return { account, chats: [chat], messages, settings };
}

const data = smokeData();

function instrumentationScript() {
  return `<script>
    window.__smokeRequests = [];
    window.__smokeErrors = [];
    window.__smokeHeartbeat = 0;
    window.__smokeMutationCount = 0;
    window.setInterval(() => { window.__smokeHeartbeat += 1; }, 100);
    window.addEventListener("error", (event) => {
      if (event.error || event.message) {
        window.__smokeErrors.push(String(event.error?.stack || event.message));
      }
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
    document.addEventListener("DOMContentLoaded", () => {
      const observer = new MutationObserver((records) => {
        window.__smokeMutationCount += records.length;
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      window.__smokeMutationObserver = observer;
    }, { once: true });
  </script>`;
}

function smokeHtml() {
  const html = fs.readFileSync(path.join(publicDir, "web.html"), "utf8");
  const injected = html.replace(
    /(<script src="\/app\.js[^>]*><\/script>)/,
    `${instrumentationScript()}\n$1`
  );
  if (injected === html) throw new Error("[browser-cdp-smoke] Unable to inject instrumentation.");
  return injected;
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
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
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
    json(response, { ok: true, users: [] });
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
      response.end(smokeHtml());
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
          reject(new Error(`Invalid JSON from ${url}: ${body.slice(0, 300)}`));
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
      const timeout = setTimeout(() => reject(new Error("CDP WebSocket connection timed out")), 5000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("CDP WebSocket connection failed"));
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
    });
  }

  send(method, params = {}, timeoutMs = 4000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP socket is not open for ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms; page main thread may be unresponsive`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 4000) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }, timeoutMs);
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Browser evaluation failed");
    }
    return response.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch {}
  }
}

async function waitForFile(filePath, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForPageTarget(port, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const targets = await httpJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await delay(100);
  }
  throw new Error("Timed out waiting for a CDP page target");
}

async function waitForCondition(client, expression, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await client.evaluate(expression, 2500)) return true;
    await delay(100);
  }
  return false;
}

async function runProfile(chrome, baseUrl, profile, width, height, mobile) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `yachat-cdp-${profile}-`));
  const stderrChunks = [];
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
  chromeProcess.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

  const activePortFile = path.join(userDataDir, "DevToolsActivePort");
  let client = null;
  try {
    await waitForFile(activePortFile);
    const [portLine] = fs.readFileSync(activePortFile, "utf8").trim().split(/\r?\n/);
    const port = Number(portLine);
    if (!Number.isFinite(port)) throw new Error("Chrome returned an invalid remote debugging port");

    const target = await waitForPageTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
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

    const loaded = await waitForCondition(client, `(() => (
      document.body?.classList.contains("messenger-mode")
      && !document.body.classList.contains("app-booting")
      && document.querySelector("[data-messenger]")?.hidden === false
      && document.querySelectorAll("[data-chat-id]").length > 0
      && document.querySelectorAll("[data-message-id]").length > 0
    ))()`, 10000);
    if (!loaded) {
      const state = await client.evaluate(`({
        bodyClass: document.body?.className || "",
        chats: document.querySelectorAll("[data-chat-id]").length,
        messages: document.querySelectorAll("[data-message-id]").length,
        errors: window.__smokeErrors || []
      })`);
      throw new Error(`${profile} messenger did not finish loading: ${JSON.stringify(state)}`);
    }

    const settingsOpened = await client.evaluate(`(() => {
      const button = document.querySelector('[data-rail="settings"]');
      button?.click();
      return Boolean(button);
    })()`);
    await delay(250);
    const panelVisible = await client.evaluate(`document.querySelector("[data-side-panel]")?.hidden === false`);
    await client.evaluate(`(() => {
      document.querySelector('[data-action="close-panel"]')?.click();
      document.querySelector('[data-rail="all"]')?.click();
      document.querySelector("[data-chat-id]")?.click();
      return true;
    })()`);
    await delay(300);

    const messageMenuTriggered = await client.evaluate(`(() => {
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
    await delay(200);
    const menuVisible = await client.evaluate(`Boolean(document.querySelector("[data-message-menu]:not([hidden])"))`);
    await client.evaluate(`document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }))`);

    const heartbeatStart = await client.evaluate("window.__smokeHeartbeat || 0");
    const heartbeatSamples = [];
    for (let index = 0; index < 7; index += 1) {
      await delay(1000);
      heartbeatSamples.push(await client.evaluate("window.__smokeHeartbeat || 0", 2500));
    }

    const metrics = await client.evaluate(`(() => {
      const requestUrls = (window.__smokeRequests || []).map((item) => item.url);
      return {
        settingsButtonFound: ${JSON.stringify(Boolean(settingsOpened))},
        panelVisible: ${JSON.stringify(Boolean(panelVisible))},
        messageMenuTriggered: ${JSON.stringify(Boolean(messageMenuTriggered))},
        menuVisible: ${JSON.stringify(Boolean(menuVisible))},
        runtimeGuard: document.documentElement.dataset.yachatRuntimeGuard || "",
        backgroundDelegated: window.__yachatBackgroundSyncDelegated === true,
        activePollMs: Number(document.documentElement.dataset.yachatActivePollMs || 0),
        fullSnapshots: requestUrls.filter((url) => /\\/api\\/messenger(?:\\?|$)/.test(url)).length,
        compactChatPolls: requestUrls.filter((url) => url.includes("/api/chats/poll")).length,
        messagePolls: requestUrls.filter((url) => url.includes("/api/messages")).length,
        totalRequests: requestUrls.length,
        heartbeat: window.__smokeHeartbeat || 0,
        mutations: window.__smokeMutationCount || 0,
        errors: window.__smokeErrors || [],
        chats: document.querySelectorAll("[data-chat-id]").length,
        messages: document.querySelectorAll("[data-message-id]").length
      };
    })()`);
    metrics.heartbeatDelta = Number(metrics.heartbeat || 0) - Number(heartbeatStart || 0);
    metrics.heartbeatSamples = heartbeatSamples;

    const problems = [];
    if (!metrics.settingsButtonFound || !metrics.panelVisible) problems.push("settings menu did not open");
    if (!metrics.messageMenuTriggered || !metrics.menuVisible) problems.push("message menu did not open");
    if (metrics.runtimeGuard !== "optimized-refresh-v2") problems.push("optimized runtime guard missing");
    if (!metrics.backgroundDelegated) problems.push("background sync did not delegate");
    if (metrics.activePollMs < 1000) problems.push("poll interval below 1000ms");
    if (metrics.fullSnapshots !== 0) problems.push("full messenger snapshot polling is active");
    if (metrics.messagePolls < 2) problems.push("incremental message polling did not run");
    if (metrics.totalRequests > 30) problems.push("too many requests during smoke window");
    if (metrics.heartbeatDelta < 45) problems.push("main thread heartbeat stalled");
    if (metrics.mutations > 1800) problems.push("excessive DOM mutations");
    if (metrics.errors.length) problems.push("browser errors occurred");

    if (problems.length) {
      throw new Error(`${profile} failed: ${problems.join("; ")} ${JSON.stringify(metrics)}`);
    }

    console.log(`[browser-cdp-smoke] ${profile} PASS ${JSON.stringify(metrics)}`);
    return metrics;
  } catch (error) {
    const browserLog = stderrChunks.join("").slice(-3000);
    throw new Error(`${error.message}\nChrome stderr:\n${browserLog}`);
  } finally {
    client?.close();
    chromeProcess.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => chromeProcess.once("close", resolve)),
      delay(1500)
    ]);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function main() {
  if (!fs.existsSync(path.join(publicDir, "web.html"))) {
    throw new Error("[browser-cdp-smoke] public/web.html is missing. Run npm run build first.");
  }

  const chrome = findChrome();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const desktop = await runProfile(chrome, baseUrl, "desktop", 1440, 900, false);
    const mobile = await runProfile(chrome, baseUrl, "mobile", 390, 844, true);
    console.log(`[browser-cdp-smoke] PASS ${JSON.stringify({ desktop, mobile })}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

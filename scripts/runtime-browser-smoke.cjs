const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");

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

function preAppScript() {
  return `<script>
    window.__smokeRequests = [];
    window.__smokeErrors = [];
    window.__smokeHeartbeat = 0;
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
      const waitFor = async (test, timeout = 6000) => {
        const started = performance.now();
        while (performance.now() - started < timeout) {
          if (test()) return true;
          await sleep(50);
        }
        return false;
      };
      const fail = (message, details = {}) => {
        const node = document.createElement("pre");
        node.id = "runtime-smoke-result";
        node.textContent = "RUNTIME_SMOKE_FAIL:" + JSON.stringify({ profile, message, ...details });
        document.body.append(node);
        document.title = "RUNTIME_SMOKE_FAIL";
      };

      (async () => {
        const mutations = { count: 0 };
        const observer = new MutationObserver((records) => { mutations.count += records.length; });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });

        const loaded = await waitFor(() => (
          document.body.classList.contains("messenger-mode")
          && !document.body.classList.contains("app-booting")
          && document.querySelector("[data-messenger]")?.hidden === false
          && document.querySelectorAll("[data-chat-id]").length > 0
          && document.querySelectorAll("[data-message-id]").length > 0
        ));
        if (!loaded) {
          fail("messenger did not finish loading", {
            bodyClass: document.body.className,
            chats: document.querySelectorAll("[data-chat-id]").length,
            messages: document.querySelectorAll("[data-message-id]").length,
            errors: window.__smokeErrors
          });
          return;
        }

        document.querySelector('[data-rail="settings"]')?.click();
        await sleep(200);
        const settingsOpened = document.querySelector("[data-side-panel]")?.hidden === false;
        document.querySelector('[data-action="close-panel"]')?.click();
        document.querySelector('[data-rail="all"]')?.click();
        document.querySelector("[data-chat-id]")?.click();
        await sleep(300);

        const firstMessage = document.querySelector("[data-message-id]");
        firstMessage?.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 220
        }));
        await sleep(180);
        const menuOpened = Boolean(document.querySelector("[data-message-menu]:not([hidden])"));
        document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        const heartbeatBeforePolling = window.__smokeHeartbeat;
        await sleep(6800);
        observer.disconnect();

        const requestUrls = window.__smokeRequests.map((item) => item.url);
        const fullSnapshots = requestUrls.filter((url) => /\/api\/messenger(?:\?|$)/.test(url));
        const compactChatPolls = requestUrls.filter((url) => url.includes("/api/chats/poll"));
        const messagePolls = requestUrls.filter((url) => url.includes("/api/messages"));
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
          totalRequests: requestUrls.length,
          heartbeatDelta,
          mutations: mutations.count,
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
        if (checks.totalRequests > 30) problems.push("too many requests during smoke window");
        if (heartbeatDelta < 35) problems.push("main thread stopped responding");
        if (checks.mutations > 1600) problems.push("excessive DOM mutation activity");
        if (checks.errors.length) problems.push("browser errors occurred");

        if (problems.length) {
          fail(problems.join("; "), checks);
          return;
        }

        const node = document.createElement("pre");
        node.id = "runtime-smoke-result";
        node.textContent = "RUNTIME_SMOKE_PASS:" + JSON.stringify({ profile, ...checks });
        document.body.append(node);
        document.title = "RUNTIME_SMOKE_PASS";
      })().catch((error) => fail(error.message || String(error), {
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
    `${preAppScript()}\n$1`
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

function runChrome(chrome, baseUrl, profile, width, height) {
  return new Promise((resolve, reject) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `yachat-smoke-${profile}-`));
    const url = `${baseUrl}/web?local=1&profile=${encodeURIComponent(profile)}`;
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
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      "--virtual-time-budget=15000",
      "--run-all-compositor-stages-before-draw",
      "--dump-dom",
      url
    ];
    const child = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`[browser-smoke] ${profile} browser timed out, indicating an unresponsive page.`));
    }, 40000);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      fs.rmSync(userDataDir, { recursive: true, force: true });
      const match = stdout.match(/RUNTIME_SMOKE_(?:PASS|FAIL):[^<]+/);
      const result = match?.[0] || "missing smoke result";
      if (code !== 0 || !result.startsWith("RUNTIME_SMOKE_PASS:")) {
        reject(new Error(`[browser-smoke] ${profile} failed (exit ${code}): ${result}\n${stderr.slice(-2000)}`));
        return;
      }
      console.log(`[browser-smoke] ${profile} ${result}`);
      resolve();
    });
  });
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

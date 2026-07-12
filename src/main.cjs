const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createLocalBackend } = require("./server/local-backend.cjs");

const APP_TITLE = "ЯЧат";
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const WEB_PORT = 3087;
const PROJECT_ROOT = path.resolve(__dirname, "..");
const APP_ICON_PATH = path.join(__dirname, "renderer", "assets", "yachat.ico");
const APP_USER_MODEL_ID = "ru.yachat.desktop";
const WEB_SERVER_INFO_PATH = path.join(PROJECT_ROOT, "USERS", "server", "web-server.json");

let mainWindow;
let sessionChallenge = null;
let localBackend;
let webServerInfo = null;

function configureMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(["media", "camera", "microphone"].includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ["media", "camera", "microphone"].includes(permission);
  });
}

function createCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function normalizeContact(contact) {
  return String(contact || "").trim().replace(/\s+/g, " ");
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

function createAccountUsername(displayName, preferredUsername) {
  let username = normalizeUsername(preferredUsername) || normalizeUsername(displayName) || "user";

  if (username.length < 3) {
    username = `${username || "user"}_${crypto.randomInt(1000, 10000)}`;
  }

  return username.slice(0, 24);
}

function getLanAddress() {
  const networks = os.networkInterfaces();

  for (const entries of Object.values(networks)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  return "127.0.0.1";
}

function publicAccount(account) {
  if (!account) {
    return null;
  }

  return {
    id: account.id,
    title: APP_TITLE,
    displayName: account.displayName,
    username: account.username,
    bio: account.bio || "",
    contact: account.contact || "зашифровано",
    method: account.method || "phone",
    avatarDataUrl: account.avatarDataUrl || "",
    avatarAccent: account.avatarAccent || "#471AFF",
    createdAt: account.createdAt,
    status: account.status || "account-created",
    encrypted: Boolean(account.encrypted),
    verified: Boolean(account.verified),
    roleLabel: account.roleLabel || "",
    verifiedTitle: account.verifiedTitle || "",
    verifiedDescription: account.verifiedDescription || ""
  };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    previewName: user.previewName || user.username,
    displayName: user.displayName || user.previewName || user.username,
    bio: user.bio || "",
    contact: user.contact || "",
    matchedContact: user.matchedContact || "",
    avatarDataUrl: user.avatarDataUrl || "",
    avatarAccent: user.avatarAccent || "#471AFF",
    createdAt: user.createdAt,
    encrypted: Boolean(user.encrypted),
    publicKeyType: user.publicKeyType || "x25519",
    verified: Boolean(user.verified),
    roleLabel: user.roleLabel || "",
    verifiedTitle: user.verifiedTitle || "",
    verifiedDescription: user.verifiedDescription || ""
  };
}

function publicStatus(status) {
  return {
    storage: status?.storage || "encrypted-local-vault",
    users: status?.storage === "sqlite" ? "sqlite" : "encrypted",
    webUrl: webServerInfo?.webUrl || null,
    lanUrl: webServerInfo?.lanUrl || null,
    encryption: status?.encryption || {
      storage: "AES-256-GCM",
      kdf: "scrypt",
      identity: "x25519"
    }
  };
}

async function writeWebServerInfo(info) {
  try {
    await fs.mkdir(path.dirname(WEB_SERVER_INFO_PATH), { recursive: true });
    await fs.writeFile(WEB_SERVER_INFO_PATH, JSON.stringify({
      ...info,
      updatedAt: new Date().toISOString()
    }, null, 2), "utf8");
  } catch (error) {
    console.warn(`Could not write web server info: ${error.message}`);
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  response.end(JSON.stringify(payload));
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 24 * 1024 * 1024) {
        request.destroy();
        reject(new Error("Слишком большой запрос."));
      }
    });

    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Некорректный JSON."));
      }
    });

    request.on("error", reject);
  });
}

async function createChallenge(payload) {
  const method = payload?.method === "phone" ? "phone" : "email";
  const contact = normalizeContact(payload?.contact);
  const deliveryMethod = payload?.deliveryMethod === "telegram" ? "telegram" : "yachat";

  if (!contact) {
    throw new Error("Введите почту или телефон.");
  }

  if (deliveryMethod === "telegram") {
    throw new Error("Telegram is not linked for this number. Start the YaChat code bot and share your phone number first.");
  }

  const code = createCode();
  sessionChallenge = {
    method,
    contact,
    codeHash: crypto.createHash("sha256").update(code).digest("hex"),
    createdAt: Date.now(),
    expiresAt: Date.now() + CHALLENGE_TTL_MS
  };

  await localBackend.recordVerificationCode(contact, code);

  const result = {
    method,
    contact,
    expiresAt: sessionChallenge.expiresAt,
    deliveryMethod,
    delivery: { yachat: true, telegram: false, dev: false }
  };
  if (envFlag("YACHAT_RETURN_DEV_CODE", false)) {
    result.devCode = code;
    result.delivery.dev = true;
  }
  return result;
}

async function verifyChallenge(payload) {
  const code = String(payload?.code || "").replace(/\D/g, "");

  if (!sessionChallenge) {
    return { ok: false, reason: "Сначала запросите код проверки." };
  }

  if (Date.now() > sessionChallenge.expiresAt) {
    sessionChallenge = null;
    return { ok: false, reason: "Код устарел. Запросите новый." };
  }

  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  if (codeHash !== sessionChallenge.codeHash) {
    return { ok: false, reason: "Код не совпал." };
  }

  sessionChallenge.verifiedAt = Date.now();
  const verifiedChallenge = sessionChallenge;
  const account = await localBackend.findAccountByContact(verifiedChallenge.contact);

  if (account) {
    sessionChallenge = null;
  }

  return {
    ok: true,
    contact: verifiedChallenge.contact,
    method: verifiedChallenge.method,
    account: publicAccount(account),
    accountExists: Boolean(account)
  };
}

async function createAccount(payload) {
  if (!sessionChallenge?.verifiedAt) {
    throw new Error("Сначала подтвердите код.");
  }

  const existing = await localBackend.findAccountByContact(sessionChallenge.contact);
  if (existing) {
    sessionChallenge = null;
    return publicAccount(existing);
  }

  const displayName = String(payload?.displayName || "").trim();
  const username = createAccountUsername(displayName, payload?.username);
  const bio = String(payload?.bio || "").trim();
  const avatarDataUrl = String(payload?.avatarDataUrl || "");
  const avatarAccent = "#471AFF";

  if (!displayName) {
    throw new Error("Введите имя.");
  }

  if (bio.length > 140) {
    throw new Error("Описание не должно быть длиннее 140 символов.");
  }

  if (avatarDataUrl && (!avatarDataUrl.startsWith("data:image/") || avatarDataUrl.length > 700000)) {
    throw new Error("Не удалось открыть изображение.");
  }

  const account = await localBackend.createUser({
    displayName,
    username,
    bio,
    avatarDataUrl,
    avatarAccent,
    contact: sessionChallenge.contact,
    method: sessionChallenge.method
  });

  sessionChallenge = null;
  return publicAccount(account);
}

async function serveRendererAsset(response, pathname) {
  const rendererRoot = path.join(__dirname, "renderer");

  if (pathname.startsWith("/assets/")) {
    const assetName = path.basename(decodeURIComponent(pathname));
    const filePath = path.join(rendererRoot, "assets", assetName);
    const ext = path.extname(assetName).toLowerCase();
    const contentType = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".svg": "image/svg+xml; charset=utf-8",
      ".ico": "image/x-icon",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf"
    }[ext];

    if (!contentType) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400"
    });
    response.end(file);
    return;
  }

  const assetMap = new Map([
    ["/", "index.html"],
    ["/privacy", "privacy.html"],
    ["/policy", "privacy.html"],
    ["/terms", "terms.html"],
    ["/agreement", "terms.html"],
    ["/help", "help.html"],
    ["/index.html", "index.html"],
    ["/privacy.html", "privacy.html"],
    ["/terms.html", "terms.html"],
    ["/help.html", "help.html"],
    ["/app.js", "app.js"],
    ["/page-data.js", "page-data.js"],
    ["/styles.css", "styles.css"],
    ["/page.css", "page.css"]
  ]);
  const assetName = assetMap.get(pathname);

  if (!assetName) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const filePath = path.join(rendererRoot, assetName);
  const ext = path.extname(assetName);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8"
  }[ext] || "application/octet-stream";

  const file = await fs.readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(file);
}

async function serveAttachment(response, pathname) {
  const fileName = decodeURIComponent(pathname.replace("/api/attachment/", ""));
  const filePath = await localBackend.getAttachmentFile(fileName);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".pdf": "application/pdf"
  }[ext] || "application/octet-stream";

  const file = await fs.readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=86400"
  });
  response.end(file);
}

async function handleHttpRequest(request, response) {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  try {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname.startsWith("/api/attachment/")) {
      await serveAttachment(response, url.pathname);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "GET" && url.pathname === "/api/account") {
        sendJson(response, 200, await localBackend.getLastAccount().then(publicAccount));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        const account = await localBackend.getLastAccount().then(publicAccount);
        const settings = await localBackend.getSettings();
        const chats = account ? await localBackend.listChats() : [];
        const requestedChatId = url.searchParams.get("chatId") || "";
        const activeChatId = chats.some((chat) => chat.id === requestedChatId)
          ? requestedChatId
          : chats[0]?.id || null;
        const routeUsername = normalizeUsername(url.searchParams.get("username"));
        const routeUsers = routeUsername ? await localBackend.searchUsers(routeUsername) : [];
        const routeUser = routeUsers.find((item) => normalizeUsername(item.username) === routeUsername) || null;
        sendJson(response, 200, {
          authenticated: Boolean(account),
          account,
          settings,
          chats,
          activeChatId,
          messages: activeChatId ? await localBackend.getMessages(activeChatId) : [],
          routeUser: routeUser ? publicUser(routeUser) : null
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        sendJson(response, 200, publicStatus(await localBackend.getStatus()));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/settings") {
        sendJson(response, 200, await localBackend.getSettings());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/users") {
        const users = await localBackend.listUsers();
        sendJson(response, 200, users.map(publicUser));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/users/search") {
        const users = await localBackend.searchUsers(url.searchParams.get("q"));
        sendJson(response, 200, users.map(publicUser));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/users/by-username") {
        const users = await localBackend.searchUsers(url.searchParams.get("username"));
        const target = normalizeUsername(url.searchParams.get("username"));
        const user = users.find((item) => normalizeUsername(item.username) === target) || null;
        sendJson(response, 200, user ? publicUser(user) : null);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/users/check-username") {
        sendJson(response, 200, await localBackend.checkUsername(url.searchParams.get("username")));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/contacts/lookup") {
        const users = await localBackend.lookupContacts(await readRequestJson(request));
        sendJson(response, 200, users.map(publicUser));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/chats") {
        sendJson(response, 200, await localBackend.listChats());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/messages") {
        sendJson(response, 200, await localBackend.getMessages(url.searchParams.get("chatId")));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/messenger") {
        const chats = await localBackend.listChats();
        const requestedChatId = url.searchParams.get("chatId") || "";
        const activeChatId = chats.some((chat) => chat.id === requestedChatId)
          ? requestedChatId
          : chats[0]?.id || null;
        const routeUsername = normalizeUsername(url.searchParams.get("username"));
        const routeUsers = routeUsername ? await localBackend.searchUsers(routeUsername) : [];
        const routeUser = routeUsers.find((item) => normalizeUsername(item.username) === routeUsername) || null;
        sendJson(response, 200, {
          chats,
          activeChatId,
          messages: activeChatId ? await localBackend.getMessages(activeChatId) : [],
          routeUser: routeUser ? publicUser(routeUser) : null
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/settings") {
        sendJson(response, 200, await localBackend.updateSettings(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/challenge") {
        sendJson(response, 200, await createChallenge(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/verify") {
        sendJson(response, 200, await verifyChallenge(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/account") {
        sendJson(response, 200, await createAccount(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/account/update") {
        sendJson(response, 200, await localBackend.updateAccount(await readRequestJson(request)).then(publicAccount));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/logout") {
        sendJson(response, 200, await localBackend.logout());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/account/delete") {
        sendJson(response, 200, await localBackend.deleteProfile());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/message") {
        sendJson(response, 200, await localBackend.sendMessage(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/message/update") {
        sendJson(response, 200, await localBackend.updateMessage(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/message/delete") {
        sendJson(response, 200, await localBackend.deleteMessage(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/message/mark-unread") {
        sendJson(response, 200, await localBackend.markChatUnread(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat/mark-read") {
        sendJson(response, 200, await localBackend.markChatRead(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/message/forward") {
        sendJson(response, 200, await localBackend.forwardMessage(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat") {
        sendJson(response, 200, await localBackend.createChat(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat/update") {
        sendJson(response, 200, await localBackend.updateChat(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat/invite") {
        sendJson(response, 200, await localBackend.createInvite(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat/leave") {
        sendJson(response, 200, await localBackend.leaveChat(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat/delete") {
        sendJson(response, 200, await localBackend.deleteChat(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat/clear-history") {
        sendJson(response, 200, await localBackend.clearHistory(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/qr/create") {
        sendJson(response, 200, await localBackend.createQrSession(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/qr/confirm") {
        sendJson(response, 200, await localBackend.confirmQrSession(await readRequestJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/qr/status") {
        sendJson(response, 200, await localBackend.getQrSession(await readRequestJson(request)));
        return;
      }

      sendJson(response, 404, { error: "Unknown API route" });
      return;
    }

    await serveRendererAsset(response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Server error" });
  }
}

function startWebServer(port = WEB_PORT) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      handleHttpRequest(request, response);
    });

    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" && port !== 0) {
        startWebServer(0).then(resolve, reject);
        return;
      }

      reject(error);
    });

    server.listen(port, "0.0.0.0", () => {
      const actualPort = server.address().port;
      webServerInfo = {
        port: actualPort,
        webUrl: `http://127.0.0.1:${actualPort}`,
        lanUrl: `http://${getLanAddress()}:${actualPort}`
      };
      resolve(webServerInfo);
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 640,
    title: APP_TITLE,
    frame: true,
    transparent: false,
    backgroundColor: "#101116",
    icon: APP_ICON_PATH,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(async () => {
  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }
  configureMediaPermissions();
  localBackend = createLocalBackend(app, APP_TITLE);
  await localBackend.init();
  const info = await startWebServer();
  await writeWebServerInfo(info);
  console.log(`Yachat local: ${info.webUrl}`);
  console.log(`Yachat Wi-Fi: ${info.lanUrl}`);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
});

ipcMain.handle("window:toggleMaximize", () => {
  if (!mainWindow) {
    return false;
  }

  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  }

  mainWindow.maximize();
  return true;
});

ipcMain.handle("window:close", () => {
  mainWindow?.close();
});

ipcMain.handle("links:openExternal", async (_event, targetUrl) => {
  const parsed = new URL(String(targetUrl));

  if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
    throw new Error("Unsupported link protocol.");
  }

  await shell.openExternal(parsed.href);
  return true;
});

ipcMain.handle("account:get", async () => {
  return publicAccount(await localBackend.getLastAccount());
});

ipcMain.handle("server:status", async () => {
  return publicStatus(await localBackend.getStatus());
});

ipcMain.handle("settings:get", async () => {
  return localBackend.getSettings();
});

ipcMain.handle("settings:update", async (_event, payload) => {
  return localBackend.updateSettings(payload);
});

ipcMain.handle("users:list", async () => {
  const users = await localBackend.listUsers();
  return users.map(publicUser);
});

ipcMain.handle("users:search", async (_event, query) => {
  const users = await localBackend.searchUsers(query);
  return users.map(publicUser);
});

ipcMain.handle("users:check-username", async (_event, username) => {
  return localBackend.checkUsername(username);
});

ipcMain.handle("contacts:lookup", async (_event, payload) => {
  const users = await localBackend.lookupContacts(payload);
  return users.map(publicUser);
});

ipcMain.handle("chats:list", async () => {
  return localBackend.listChats();
});

ipcMain.handle("messages:list", async (_event, chatId) => {
  return localBackend.getMessages(chatId);
});

ipcMain.handle("chat:create", async (_event, payload) => {
  return localBackend.createChat(payload);
});

ipcMain.handle("chat:update", async (_event, payload) => {
  return localBackend.updateChat(payload);
});

ipcMain.handle("chat:invite", async (_event, payload) => {
  return localBackend.createInvite(payload);
});

ipcMain.handle("chat:leave", async (_event, payload) => {
  return localBackend.leaveChat(payload);
});

ipcMain.handle("chat:delete", async (_event, payload) => {
  return localBackend.deleteChat(payload);
});

ipcMain.handle("chat:clear-history", async (_event, payload) => {
  return localBackend.clearHistory(payload);
});

ipcMain.handle("message:send", async (_event, payload) => {
  return localBackend.sendMessage(payload);
});

ipcMain.handle("message:update", async (_event, payload) => {
  return localBackend.updateMessage(payload);
});

ipcMain.handle("message:delete", async (_event, payload) => {
  return localBackend.deleteMessage(payload);
});

ipcMain.handle("message:mark-unread", async (_event, payload) => {
  return localBackend.markChatUnread(payload);
});

ipcMain.handle("chat:mark-read", async (_event, payload) => {
  return localBackend.markChatRead(payload);
});

ipcMain.handle("message:forward", async (_event, payload) => {
  return localBackend.forwardMessage(payload);
});

ipcMain.handle("qr:create", async (_event, payload) => {
  return localBackend.createQrSession(payload);
});

ipcMain.handle("qr:confirm", async (_event, payload) => {
  return localBackend.confirmQrSession(payload);
});

ipcMain.handle("qr:status", async (_event, payload) => {
  return localBackend.getQrSession(payload);
});

ipcMain.handle("challenge:create", async (_event, payload) => {
  return createChallenge(payload);
});

ipcMain.handle("challenge:verify", async (_event, payload) => {
  return verifyChallenge(payload);
});

ipcMain.handle("account:create", async (_event, payload) => {
  return createAccount(payload);
});

ipcMain.handle("account:update", async (_event, payload) => {
  return publicAccount(await localBackend.updateAccount(payload));
});

ipcMain.handle("account:delete-profile", async () => {
  return localBackend.deleteProfile();
});

ipcMain.handle("account:logout", async () => {
  return localBackend.logout();
});

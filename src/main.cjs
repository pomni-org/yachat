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
    ["/agreement", "te
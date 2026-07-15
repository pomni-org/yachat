const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const CIPHER = "aes-256-gcm";
const KDF = "scrypt";
const REMOVED_TEST_MESSAGE_TEXTS = new Set(["Приыет?"]);
const SYSTEM_OWNER = {
  id: "murochko",
  username: "murochko",
  displayName: "Мурочко",
  roleLabel: "Владелец",
  verified: true,
  verifiedTitle: "Мурочко",
  verifiedDescription: "Владелец ЯЧата. Этот значок подтверждает главный системный аккаунт."
};

function identityText(value) {
  return String(value || "").trim().toLowerCase().replace(/^@+/, "").replace(/\s+/g, "");
}

function isMurochkoProfile(profile) {
  return [profile?.username, profile?.displayName, profile?.previewName, profile?.title, profile?.ownerUsername, profile?.ownerName]
    .map(identityText)
    .some((value) => value === "murochko" || value === "мурочко");
}

function findMurochkoProfile(profiles = []) {
  return profiles.find((profile) => isMurochkoProfile(profile)) || null;
}

function verificationFields(profile) {
  if (isMurochkoProfile(profile)) {
    return {
      verified: true,
      roleLabel: "Владелец",
      verifiedTitle: "Мурочко",
      verifiedDescription: "Владелец ЯЧата. Этот значок подтверждает главный системный аккаунт."
    };
  }

  return {
    verified: false,
    roleLabel: "",
    verifiedTitle: "",
    verifiedDescription: ""
  };
}

function safeSegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "user";
}

function deriveKey(secret, salt) {
  return crypto.scryptSync(String(secret), salt, 32);
}

function encryptJson(payload, secret) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(secret, salt);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  const source = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  const encrypted = Buffer.concat([cipher.update(source), cipher.final()]);

  return {
    version: 1,
    cipher: CIPHER,
    kdf: KDF,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    payload: encrypted.toString("base64")
  };
}

function createIdentity() {
  try {
    const pair = crypto.generateKeyPairSync("x25519");
    return {
      type: "x25519",
      publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
      privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" })
    };
  } catch {
    return {
      type: "local-dev-key",
      publicKey: crypto.randomBytes(32).toString("base64"),
      privateKey: crypto.randomBytes(32).toString("base64")
    };
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function sanitizeFileName(value) {
  return String(value || "file")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96) || "file";
}

function cleanPersonalText(value, fallback = "") {
  const text = String(value || "").replace(/\uFFFD/g, "?").trim();
  const fallbackText = String(fallback || "").trim();

  if (!text || /^[?\s]+$/.test(text)) {
    return fallbackText;
  }

  const questionMarks = (text.match(/\?/g) || []).length;
  if (questionMarks >= Math.max(3, Math.floor(text.length * 0.45))) {
    return fallbackText;
  }

  return text;
}

function normalizeProfileText(value, limit = 180) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, limit);
}

function normalizeAvatarDataUrl(value) {
  const dataUrl = String(value || "");

  if (!dataUrl) {
    return "";
  }

  if (!dataUrl.startsWith("data:image/") || dataUrl.length > 900000) {
    throw new Error("Не удалось открыть изображение.");
  }

  return dataUrl;
}

function attachmentKind(mime, name) {
  const source = `${mime || ""} ${name || ""}`.toLowerCase();

  if (source.includes("image/")) {
    return "image";
  }

  if (source.includes("video/")) {
    return "video";
  }

  return "file";
}

function createLocalBackend(app, appTitle) {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const appRoot = path.join(projectRoot, "USERS");
  const legacyRoot = path.join(app.getPath("documents"), appTitle);
  const usersRoot = path.join(appRoot, "users");
  const serverRoot = path.join(appRoot, "server");
  const attachmentsRoot = path.join(appRoot, "attachments");
  const databasePath = path.join(serverRoot, "yachat.sqlite");
  const settingsPath = path.join(serverRoot, "settings.json");
  const chatsPath = path.join(serverRoot, "chats.json");
  const sessionsPath = path.join(serverRoot, "qr-sessions.json");
  let database = null;
  let initialized = false;
  let initPromise = null;

  const defaultSettings = {
    language: "ru",
    theme: "dark",
    country: "RU",
    countryCode: "+7",
    lastUserId: null,
    signedOut: false,
    updatedAt: null
  };

  function requireSqliteRuntime() {
    if (!DatabaseSync) {
      throw new Error("SQLite недоступен в этом Node/Electron. Нужен Node/Electron со встроенным node:sqlite.");
    }
  }

  function db() {
    if (!database) {
      requireSqliteRuntime();
      database = new DatabaseSync(databasePath);
      database.exec("pragma journal_mode = WAL");
      database.exec("pragma foreign_keys = ON");
    }

    return database;
  }

  function dbGet(sql, params = []) {
    return db().prepare(sql).get(...params);
  }

  function dbAll(sql, params = []) {
    return db().prepare(sql).all(...params);
  }

  function dbRun(sql, params = []) {
    return db().prepare(sql).run(...params);
  }

  function runInTransaction(callback) {
    const connection = db();
    connection.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      connection.exec("COMMIT");
      return result;
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  }

  function parseStoredJson(value, fallback) {
    if (!value) {
      return fallback;
    }

    try {
      return JSON.parse(String(value));
    } catch {
      return fallback;
    }
  }

  function boolToDb(value) {
    return value ? 1 : 0;
  }

  function dbToBool(value) {
    return value === 1 || value === true;
  }

  function ensureSchema() {
    db().exec(`
      create table if not exists meta (
        key text primary key,
        value text not null
      );

      create table if not exists settings (
        key text primary key,
        value text not null
      );

      create table if not exists users (
        id text primary key,
        username text not null,
        preview_name text not null,
        display_name text not null,
        bio text not null default '',
        contact text not null,
        contact_key text not null,
        method text not null default 'phone',
        avatar_data_url text not null default '',
        avatar_accent text not null default '#471AFF',
        folder text not null default '',
        encrypted integer not null default 1,
        public_key_type text not null default 'x25519',
        public_key text not null default '',
        vault_json text not null default '',
        created_at text not null,
        updated_at text not null
      );

      create unique index if not exists users_contact_key_idx on users(contact_key);
      create unique index if not exists users_username_idx on users(lower(username));
      create index if not exists users_search_idx on users(username, display_name, contact_key);

      create table if not exists chats (
        id text primary key,
        data_json text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists messages (
        id text primary key,
        chat_id text not null references chats(id) on delete cascade,
        data_json text not null,
        created_at text not null
      );

      create index if not exists messages_chat_created_idx on messages(chat_id, created_at);

      create table if not exists qr_sessions (
        id text primary key,
        data_json text not null,
        updated_at text not null
      );
    `);
  }

  function readMeta(key) {
    return dbGet("select value from meta where key = ?", [key])?.value || "";
  }

  function writeMeta(key, value) {
    dbRun(
      "insert into meta(key, value) values(?, ?) on conflict(key) do update set value = excluded.value",
      [key, String(value)]
    );
  }

  function getSettingRows() {
    const rows = dbAll("select key, value from settings");
    return Object.fromEntries(rows.map((row) => [row.key, parseStoredJson(row.value, row.value)]));
  }

  function writeSettingRows(settings) {
    const insert = db().prepare(`
      insert into settings(key, value)
      values(?, ?)
      on conflict(key) do update set value = excluded.value
    `);
    runInTransaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        insert.run(key, JSON.stringify(value));
      }
    });
  }

  function ensureDefaultSettings() {
    const stored = getSettingRows();
    if (Object.keys(stored).length === 0) {
      writeSettingRows({
        ...defaultSettings,
        updatedAt: new Date().toISOString()
      });
    }
  }

  async function m
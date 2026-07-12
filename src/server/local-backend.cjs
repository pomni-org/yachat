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

  async function migrateLegacyStorage() {
    try {
      await fs.access(settingsPath);
      return;
    } catch {
      // Project-local storage is empty.
    }

    if (legacyRoot === appRoot) {
      return;
    }

    try {
      await fs.access(legacyRoot);
      await fs.cp(legacyRoot, appRoot, { recursive: true, force: false, errorOnExist: false });
    } catch {
      // Fresh install or old storage is unavailable.
    }
  }

  async function readLegacyManifests() {
    try {
      const entries = await fs.readdir(usersRoot, { withFileTypes: true });
      const users = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const manifest = await readManifest(path.join(usersRoot, entry.name));
        if (manifest) {
          users.push(manifest);
        }
      }

      return users.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async function migrateLegacyDatabase() {
    if (readMeta("legacy_migrated") === "1") {
      return;
    }

    const legacySettings = await readJson(settingsPath, null);
    if (legacySettings && Object.keys(getSettingRows()).length === 0) {
      writeSettingRows({
        ...defaultSettings,
        ...legacySettings,
        updatedAt: legacySettings.updatedAt || new Date().toISOString()
      });
    }

    for (const manifest of await readLegacyManifests()) {
      const existing = dbGet("select id from users where id = ? or contact_key = ? limit 1", [
        manifest.id,
        contactKey(manifest.contact)
      ]);
      if (existing) {
        continue;
      }

      const userDir = path.join(usersRoot, manifest.folder || "");
      const vault = await readJson(path.join(userDir, manifest.vaultFile || "vault.enc.json"), null);
      insertUserManifest(manifest, vault);
    }

    const chatCount = Number(dbGet("select count(*) as count from chats")?.count || 0);
    const legacyChats = await readJson(chatsPath, null);
    if (chatCount === 0 && legacyChats) {
      persistMessengerState(ensureSystemChats(legacyChats));
    }

    const legacySessions = await readJson(sessionsPath, null);
    if (legacySessions?.sessions && Number(dbGet("select count(*) as count from qr_sessions")?.count || 0) === 0) {
      const insertSession = db().prepare(`
        insert into qr_sessions(id, data_json, updated_at)
        values(?, ?, ?)
        on conflict(id) do update set data_json = excluded.data_json, updated_at = excluded.updated_at
      `);
      runInTransaction(() => {
        for (const [id, session] of Object.entries(legacySessions.sessions)) {
          insertSession.run(id, JSON.stringify(session), session.updatedAt || legacySessions.updatedAt || new Date().toISOString());
        }
      });
    }

    writeMeta("legacy_migrated", "1");
  }

  async function init() {
    if (initialized) {
      return;
    }

    if (initPromise) {
      await initPromise;
      return;
    }

    initPromise = (async () => {
      await migrateLegacyStorage();
      await fs.mkdir(serverRoot, { recursive: true });
      await fs.mkdir(attachmentsRoot, { recursive: true });
      db();
      ensureSchema();
      await migrateLegacyDatabase();
      ensureDefaultSettings();
      await ensureMessengerState();
      initialized = true;
    })();

    try {
      await initPromise;
    } finally {
      if (!initialized) {
        initPromise = null;
      }
    }
  }

  async function getSettings() {
    await init();
    const settings = getSettingRows();
    return { ...defaultSettings, ...settings };
  }

  async function updateSettings(patch) {
    const settings = await getSettings();
    const next = {
      ...settings,
      updatedAt: new Date().toISOString()
    };

    if (patch && patch.language === "ru") {
      next.language = "ru";
    }

    if (patch && ["dark", "light"].includes(patch.theme)) {
      next.theme = patch.theme;
    }

    if (patch?.country) {
      next.country = String(patch.country).slice(0, 8);
    }

    if (patch?.countryCode) {
      next.countryCode = String(patch.countryCode).slice(0, 8);
    }

    if (Object.prototype.hasOwnProperty.call(patch || {}, "lastUserId")) {
      next.lastUserId = patch.lastUserId || null;
    }

    if (Object.prototype.hasOwnProperty.call(patch || {}, "signedOut")) {
      next.signedOut = Boolean(patch.signedOut);
    }

    writeSettingRows(next);
    return next;
  }

  async function getStatus() {
    await init();
    return {
      appRoot,
      databasePath,
      usersRoot,
      serverRoot,
      attachmentsRoot,
      settingsPath: databasePath,
      storage: "sqlite",
      encryption: {
        storage: CIPHER,
        kdf: KDF,
        identity: "x25519",
        note: "Локальная копия E2EE: профиль шифруется на устройстве. Настоящее E2EE требует второго клиента и обмена ключами."
      }
    };
  }

  async function readManifest(userDir) {
    const manifest = await readJson(path.join(userDir, "manifest.json"), null);

    if (!manifest) {
      return null;
    }

    const username = cleanPersonalText(manifest.username, "user");

    return {
      ...manifest,
      username,
      previewName: cleanPersonalText(manifest.previewName, username),
      bio: cleanPersonalText(manifest.bio, ""),
      contact: cleanPersonalText(manifest.contact, ""),
      method: manifest.method === "email" ? "email" : "phone"
    };
  }

  function contactKey(contact) {
    return String(contact || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^\d+a-z@._-]+/g, "");
  }

  function contactLookupKeys(contact) {
    const digits = String(contact || "").replace(/\D/g, "");
    const keys = new Set();

    if (!digits) {
      return keys;
    }

    keys.add(digits);

    if (digits.length === 11 && digits.startsWith("8")) {
      keys.add(`7${digits.slice(1)}`);
    }

    if (digits.length === 11 && digits.startsWith("7")) {
      keys.add(digits.slice(1));
    }

    if (digits.length === 10) {
      keys.add(`7${digits}`);
    }

    return keys;
  }

  function uniqueUsername(baseUsername) {
    const base = safeSegment(baseUsername).slice(0, 24) || "user";
    let username = base;
    let suffix = 1;

    while (dbGet("select id from users where lower(username) = lower(?) limit 1", [username])) {
      suffix += 1;
      username = `${base.slice(0, 18)}_${suffix}`;
    }

    return username;
  }

  function manifestFromRow(row) {
    if (!row) {
      return null;
    }

    const username = cleanPersonalText(row.username, "user");
    const previewName = cleanPersonalText(row.preview_name, username);

    return {
      id: row.id,
      folder: row.folder || "",
      username,
      previewName,
      displayName: cleanPersonalText(row.display_name, previewName),
      bio: cleanPersonalText(row.bio, ""),
      contact: cleanPersonalText(row.contact, ""),
      contactKey: cleanPersonalText(row.contact_key, ""),
      method: row.method === "email" ? "email" : "phone",
      avatarDataUrl: row.avatar_data_url || "",
      avatarAccent: row.avatar_accent || "#471AFF",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      encrypted: dbToBool(row.encrypted),
      publicKeyType: row.public_key_type || "x25519",
      publicKey: row.public_key || "",
      vaultFile: "",
      vault: parseStoredJson(row.vault_json, null),
      encryption: {
        storage: CIPHER,
        kdf: KDF
      }
    };
  }

  function insertUserManifest(manifest, vault = null) {
    const now = new Date().toISOString();
    const id = String(manifest.id || crypto.randomUUID());
    let username = safeSegment(manifest.username);
    if (dbGet("select id from users where lower(username) = lower(?) and id <> ? limit 1", [username, id])) {
      username = uniqueUsername(username);
    }
    const previewName = cleanPersonalText(manifest.previewName || manifest.displayName, username);
    const contact = cleanPersonalText(manifest.contact, "");
    const key = cleanPersonalText(manifest.contactKey, "") || contactKey(contact) || `id:${id}`;

    dbRun(
      `
      insert into users(
        id, username, preview_name, display_name, bio, contact, contact_key, method,
        avatar_data_url, avatar_accent, folder, encrypted, public_key_type, public_key,
        vault_json, created_at, updated_at
      )
      values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        username,
        previewName,
        cleanPersonalText(manifest.displayName, previewName),
        cleanPersonalText(manifest.bio, ""),
        contact,
        key,
        manifest.method === "email" ? "email" : "phone",
        manifest.avatarDataUrl || "",
        manifest.avatarAccent || "#471AFF",
        manifest.folder || "",
        boolToDb(manifest.encrypted !== false),
        manifest.publicKeyType || "x25519",
        manifest.publicKey || "",
        vault ? JSON.stringify(vault) : JSON.stringify(manifest.vault || null),
        manifest.createdAt || now,
        manifest.updatedAt || manifest.createdAt || now
      ]
    );
  }

  function accountFromManifest(manifest) {
    if (!manifest) {
      return null;
    }

    return {
      id: manifest.id,
      title: appTitle,
      displayName: cleanPersonalText(manifest.previewName, manifest.username || "user"),
      username: cleanPersonalText(manifest.username, "user"),
      bio: cleanPersonalText(manifest.bio, ""),
      contact: cleanPersonalText(manifest.contact, "зашифровано"),
      method: manifest.method || "phone",
      avatarDataUrl: manifest.avatarDataUrl || "",
      avatarAccent: manifest.avatarAccent || "#471AFF",
      createdAt: manifest.createdAt,
      status: "account-created",
      encrypted: true,
      userDir: databasePath,
      ...verificationFields(manifest)
    };
  }

  async function readAllManifests() {
    const rows = dbAll("select * from users order by created_at desc");
    return rows.map(manifestFromRow);
  }

  function userChatProfile(manifest) {
    if (!manifest) {
      return null;
    }

    const username = cleanPersonalText(manifest.username, "user");
    const displayName = cleanPersonalText(manifest.previewName, username);

    return {
      id: manifest.id,
      username,
      displayName,
      previewName: displayName,
      contact: cleanPersonalText(manifest.contact, ""),
      avatarDataUrl: manifest.avatarDataUrl || "",
      avatarAccent: manifest.avatarAccent || "#471AFF",
      ...verificationFields(manifest)
    };
  }

  function publicDirectoryUser(manifest, extra = {}) {
    const username = cleanPersonalText(manifest.username, "user");
    const displayName = cleanPersonalText(manifest.previewName, username);

    return {
      id: manifest.id,
      username,
      previewName: displayName,
      displayName,
      bio: cleanPersonalText(manifest.bio, ""),
      contact: cleanPersonalText(manifest.contact, ""),
      matchedContact: cleanPersonalText(extra.matchedContact, ""),
      avatarDataUrl: manifest.avatarDataUrl || "",
      avatarAccent: manifest.avatarAccent || "#471AFF",
      createdAt: manifest.createdAt,
      encrypted: true,
      publicKeyType: manifest.publicKeyType || "x25519",
      ...verificationFields(manifest)
    };
  }

  function payloadChatProfile(id, profile) {
    const profileId = String(id || profile?.id || "").trim();

    if (!profileId) {
      return null;
    }

    const username = cleanPersonalText(profile?.username, "user");
    const displayName = cleanPersonalText(profile?.displayName || profile?.previewName, username);

    return {
      id: profileId,
      username,
      displayName,
      previewName: displayName,
      contact: cleanPersonalText(profile?.contact || profile?.matchedContact, ""),
      avatarDataUrl: profile?.avatarDataUrl || "",
      avatarAccent: profile?.avatarAccent || "#471AFF",
      ...verificationFields(profile)
    };
  }

  function createUserMap(users) {
    return new Map(users.map((user) => [user.id, userChatProfile(user)]));
  }

  function uniqueIds(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map((value) => String(typeof value === "object" ? value?.id : value || "").trim())
      .filter(Boolean))];
  }

  function chatParticipantIds(chat) {
    if (Array.isArray(chat?.participantIds)) {
      return uniqueIds(chat.participantIds);
    }

    if (Array.isArray(chat?.participants)) {
      return uniqueIds(chat.participants);
    }

    return [];
  }

  function chatVisibleForAccount(chat, account) {
    const ids = chatParticipantIds(chat);
    return ids.length === 0 || Boolean(account?.id && ids.includes(account.id));
  }

  function isInsideDirectory(parentDir, childPath) {
    const relative = path.relative(path.resolve(parentDir), path.resolve(childPath));
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  async function findAccountByContact(contact) {
    await init();

    const key = contactKey(contact);
    if (!key) {
      return null;
    }

    const row = dbGet("select * from users where contact_key = ? limit 1", [key]);
    const manifest = manifestFromRow(row);
    if (!manifest) {
      return null;
    }

    await updateSettings({ lastUserId: manifest.id, signedOut: false });
    return accountFromManifest(manifest);
  }

  async function listUsers() {
    await init();
    return readAllManifests();
  }

  async function lookupContacts(payload) {
    await init();

    const contacts = Array.isArray(payload?.contacts) ? payload.contacts : [];
    const requested = new Set();
    const submittedByKey = new Map();

    contacts.forEach((item) => {
      const source = typeof item === "object" ? item?.phone || item?.tel || item?.contact : item;
      contactLookupKeys(source).forEach((key) => {
        requested.add(key);
        if (!submittedByKey.has(key)) {
          submittedByKey.set(key, source);
        }
      });
    });

    if (requested.size === 0) {
      return [];
    }

    const account = await getLastAccount();
    const users = await readAllManifests();

    return users
      .filter((manifest) => manifest.id !== account?.id)
      .filter((manifest) => [...contactLookupKeys(manifest.contact)].some((key) => requested.has(key)))
      .map((manifest) => {
        const matchedKey = [...contactLookupKeys(manifest.contact)].find((key) => requested.has(key));
        return publicDirectoryUser(manifest, { matchedContact: submittedByKey.get(matchedKey) || "" });
      });
  }

  async function searchUsers(query) {
    await init();

    const rawQuery = String(query || "").trim();
    const text = rawQuery.toLowerCase().replace(/^@+/, "");
    const digits = rawQuery.replace(/\D/g, "");

    if (!rawQuery || (rawQuery.length < 2 && digits.length < 3)) {
      return [];
    }

    const account = await getLastAccount();
    const users = await readAllManifests();

    return users
      .filter((manifest) => manifest.id !== account?.id)
      .filter((manifest) => {
        const username = cleanPersonalText(manifest.username, "user").toLowerCase();
        const displayName = cleanPersonalText(manifest.previewName, username).toLowerCase();
        const bio = cleanPersonalText(manifest.bio, "").toLowerCase();
        const contact = cleanPersonalText(manifest.contact, "").toLowerCase();
        const contactDigits = contact.replace(/\D/g, "");

        return username.includes(text)
          || `@${username}`.includes(rawQuery.toLowerCase())
          || displayName.includes(text)
          || bio.includes(text)
          || contact.includes(text)
          || (digits.length >= 3 && contactDigits.includes(digits));
      })
      .slice(0, 25)
      .map((manifest) => publicDirectoryUser(manifest));
  }

  async function checkUsername(username) {
    await init();

    const normalized = safeSegment(username).slice(0, 24);
    const account = await getLastAccount();

    if (!normalized || normalized.length < 3) {
      return { username: normalized, available: false };
    }

    const taken = dbGet("select id from users where lower(username) = lower(?) and id <> ? limit 1", [normalized, account?.id || ""]);
    return {
      username: normalized,
      available: !taken
    };
  }

  async function getLastAccount() {
    const settings = await getSettings();
    const users = await listUsers();
    const manifest = settings.signedOut
      ? null
      : users.find((user) => user.id === settings.lastUserId) || users[0];

    if (!manifest) {
      return null;
    }

    return {
      id: manifest.id,
      title: appTitle,
      displayName: cleanPersonalText(manifest.previewName, manifest.username || "user"),
      username: cleanPersonalText(manifest.username, "user"),
      bio: cleanPersonalText(manifest.bio, ""),
      contact: "зашифровано",
      method: "phone",
      avatarDataUrl: manifest.avatarDataUrl || "",
      avatarAccent: manifest.avatarAccent || "#471AFF",
      createdAt: manifest.createdAt,
      status: "account-created",
      encrypted: true,
      userDir: databasePath,
      ...verificationFields(manifest)
    };
  }

  async function createUser(payload) {
    await init();

    const existing = await findAccountByContact(payload.contact);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const username = uniqueUsername(payload.username);
    const folder = `${username}_${id.slice(0, 8)}`;
    const identity = createIdentity();

    const account = {
      id,
      title: appTitle,
      displayName: normalizeProfileText(payload.displayName, 60),
      username,
      bio: normalizeProfileText(payload.bio, 140),
      contact: String(payload.contact || "").trim(),
      method: payload.method === "phone" ? "phone" : "email",
      avatarDataUrl: normalizeAvatarDataUrl(payload.avatarDataUrl),
      avatarAccent: String(payload.avatarAccent || "#471AFF"),
      createdAt: now,
      status: "account-created"
    };
    const vaultSecret = crypto.randomBytes(32).toString("base64");

    const vault = encryptJson({
      account,
      identity: {
        type: identity.type,
        privateKey: identity.privateKey
      },
      localOnly: true
    }, vaultSecret);

    const manifest = {
      id,
      folder,
      username,
      previewName: account.displayName,
      bio: account.bio,
      contact: account.contact,
      contactKey: contactKey(account.contact),
      method: account.method,
      avatarDataUrl: account.avatarDataUrl,
      avatarAccent: account.avatarAccent,
      createdAt: now,
      encrypted: true,
      publicKeyType: identity.type,
      publicKey: identity.publicKey,
      vaultFile: "vault.enc.json",
      encryption: {
        storage: CIPHER,
        kdf: KDF
      }
    };

    insertUserManifest(manifest, vault);
    await updateSettings({ lastUserId: id, signedOut: false });

    return {
      ...account,
      encrypted: true,
      userDir: databasePath
    };
  }

  async function updateAccount(payload) {
    await init();

    const account = await getLastAccount();
    if (!account) {
      throw new Error("Сначала войдите в аккаунт.");
    }

    const displayName = normalizeProfileText(payload?.displayName, 60);
    const username = safeSegment(payload?.username).slice(0, 24);
    const bio = normalizeProfileText(payload?.bio, 140);
    const avatarDataUrl = normalizeAvatarDataUrl(payload?.avatarDataUrl);
    const avatarAccent = String(payload?.avatarAccent || account.avatarAccent || "#471AFF").slice(0, 24);

    if (!displayName) {
      throw new Error("Введите имя.");
    }

    if (!username || username.length < 3) {
      throw new Error("Ник: 3-24 символа, латиница, цифры или подчёркивание.");
    }

    const taken = dbGet("select id from users where lower(username) = lower(?) and id <> ? limit 1", [username, account.id]);
    if (taken) {
      throw new Error("Этот ник уже занят.");
    }

    dbRun(
      `
      update users
      set username = ?,
          preview_name = ?,
          display_name = ?,
          bio = ?,
          avatar_data_url = ?,
          avatar_accent = ?,
          updated_at = ?
      where id = ?
      `,
      [username, displayName, displayName, bio, avatarDataUrl, avatarAccent, new Date().toISOString(), account.id]
    );

    return getLastAccount();
  }

  async function logout() {
    await updateSettings({ lastUserId: null, signedOut: true });
    return { ok: true };
  }

  function attachmentFileName(attachment) {
    const url = String(attachment?.url || "");
    const prefix = "/api/attachment/";

    if (!url.startsWith(prefix)) {
      return "";
    }

    try {
      const name = path.basename(decodeURIComponent(url.slice(prefix.length).split(/[?#]/)[0] || ""));
      return name && name !== "." ? name : "";
    } catch {
      return "";
    }
  }

  function collectAttachmentFiles(messages, target) {
    for (const message of Array.isArray(messages) ? messages : []) {
      for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
        const name = attachmentFileName(attachment);
        if (name) {
          target.add(name);
        }
      }
    }
  }

  async function removeAttachmentFiles(fileNames) {
    let removed = 0;

    for (const name of fileNames) {
      const filePath = path.join(attachmentsRoot, name);

      if (!isInsideDirectory(attachmentsRoot, filePath)) {
        continue;
      }

      try {
        await fs.rm(filePath, { force: true });
        removed += 1;
      } catch {
        // The message record is gone; a missing attachment file should not block account deletion.
      }
    }

    return removed;
  }

  function messageBelongsToAccount(message, manifest) {
    const accountId = String(manifest?.id || "");
    const contact = String(manifest?.contact || "").trim();
    const text = String(message?.text || "");

    if (accountId && [message?.authorId, message?.userId, message?.senderId].some((value) => String(value || "") === accountId)) {
      return true;
    }

    if (contact && text.includes(contact)) {
      return true;
    }

    const contactDigits = contact.replace(/\D/g, "");
    const textDigits = text.replace(/\D/g, "");
    return contactDigits.length >= 6 && textDigits.includes(contactDigits);
  }

  async function removeAccountDataFromMessenger(manifest) {
    const state = await ensureMessengerState();
    const accountId = String(manifest?.id || "");
    const removedChatIds = new Set();
    const attachmentFiles = new Set();
    let removedMessages = 0;
    let changed = false;

    state.chats = state.chats.filter((chat) => {
      const participantIds = chatParticipantIds(chat);
      const shouldRemoveChat = participantIds.includes(accountId) || String(chat.ownerId || "") === accountId;

      if (shouldRemoveChat) {
        collectAttachmentFiles(state.messages?.[chat.id], attachmentFiles);
        removedMessages += Array.isArray(state.messages?.[chat.id]) ? state.messages[chat.id].length : 0;
        removedChatIds.add(chat.id);
        changed = true;
        return false;
      }

      if (chat.participantProfiles && Object.prototype.hasOwnProperty.call(chat.participantProfiles, accountId)) {
        delete chat.participantProfiles[accountId];
        changed = true;
      }

      if (Array.isArray(chat.participantIds)) {
        const nextIds = participantIds.filter((id) => id !== accountId);
        if (nextIds.length !== chat.participantIds.length) {
          chat.participantIds = nextIds;
          changed = true;
        }
      }

      if (Array.isArray(chat.participants)) {
        const nextParticipants = chat.participants.filter((participant) => {
          const id = String(typeof participant === "object" ? participant?.id : participant || "").trim();
          return id !== accountId;
        });

        if (nextParticipants.length !== chat.participants.length) {
          chat.participants = nextParticipants;
          changed = true;
        }
      }

      return true;
    });

    for (const chatId of removedChatIds) {
      delete state.messages[chatId];
    }

    for (const [chatId, messages] of Object.entries(state.messages || {})) {
      if (!Array.isArray(messages)) {
        continue;
      }

      const wipeSavedMessages = chatId === "yachat-favorites";
      const nextMessages = messages.filter((message) => {
        const shouldRemoveMessage = wipeSavedMessages || messageBelongsToAccount(message, manifest);

        if (shouldRemoveMessage) {
          collectAttachmentFiles([message], attachmentFiles);
        }

        return !shouldRemoveMessage;
      });

      if (nextMessages.length !== messages.length) {
        removedMessages += messages.length - nextMessages.length;
        state.messages[chatId] = nextMessages;
        changed = true;
      }
    }

    if (changed) {
      await saveMessengerState(state);
    }

    const removedAttachments = await removeAttachmentFiles(attachmentFiles);

    return {
      removedChats: removedChatIds.size,
      removedMessages,
      removedAttachments
    };
  }

  async function deleteProfile() {
    await init();

    const settings = await getSettings();
    const users = await readAllManifests();
    const manifest = users.find((user) => user.id === settings.lastUserId) || (settings.signedOut ? null : users[0]);

    if (!manifest) {
      await updateSettings({ lastUserId: null, signedOut: true });
      return { ok: true, deleted: false, removedChats: 0, removedMessages: 0, removedAttachments: 0 };
    }

    dbRun("delete from users where id = ?", [manifest.id]);
    const cleanup = await removeAccountDataFromMessenger(manifest);
    await updateSettings({ lastUserId: null, signedOut: true });

    return { ok: true, deleted: true, ...cleanup };
  }

  function createMessage(chatId, text, author = "system", extra = {}) {
    return {
      id: crypto.randomUUID(),
      chatId,
      author,
      text: String(text || "").trim(),
      createdAt: new Date().toISOString(),
      attachments: Array.isArray(extra.attachments) ? extra.attachments : [],
      ...extra
    };
  }

  async function normalizeAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return [];
    }

    const result = [];

    for (const item of attachments.slice(0, 8)) {
      const dataUrl = String(item?.dataUrl || "");
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);

      if (!match) {
        continue;
      }

      const mime = match[1].slice(0, 120);
      const raw = Buffer.from(match[2], "base64");

      if (!raw.length) {
        continue;
      }

      if (raw.length > 8 * 1024 * 1024) {
        throw new Error("Файл слишком большой. Лимит 8 МБ.");
      }

      const name = sanitizeFileName(item.name || `file-${result.length + 1}`);
      const id = crypto.randomUUID();
      const ext = path.extname(name).slice(0, 12) || (
        mime.includes("png") ? ".png" :
        mime.includes("jpeg") || mime.includes("jpg") ? ".jpg" :
        mime.includes("webp") ? ".webp" :
        mime.includes("mp4") ? ".mp4" :
        ".bin"
      );
      const storedName = `${id}${ext}`;

      await fs.writeFile(path.join(attachmentsRoot, storedName), raw);

      result.push({
        id,
        kind: attachmentKind(mime, name),
        name,
        mime,
        size: raw.length,
        url: `/api/attachment/${storedName}`,
        dataUrl
      });
    }

    return result;
  }

  function createDefaultMessengerState() {
    const createdAt = new Date().toISOString();
    const chats = [
      {
        id: "yachat-favorites",
        kind: "saved",
        title: "Избранное",
        subtitle: "Сообщения для себя",
        locked: true,
        verified: false,
        pinned: true,
        canSend: true,
        avatar: "favorites",
        createdAt
      },
      {
        id: "yachat-codes",
        kind: "bot",
        bot: true,
        title: "Коды подтверждения",
        subtitle: "Ваши одноразовые коды от банков, магазинов и сервисов",
        description: "Ваши одноразовые коды от банков, магазинов и сервисов",
        profileKindLabel: "Системный бот",
        locked: true,
        verified: true,
        verifiedTitle: "Коды подтверждения",
        verifiedDescription: "Системный бот ЯЧата для одноразовых кодов. Историю этого бота очистить нельзя.",
        pinned: true,
        canSend: false,
        avatar: "codes",
        avatarDataUrl: "./assets/yachat-codes-avatar.webp",
        createdAt
      },
      {
        id: "yachat-channel",
        kind: "channel",
        title: "ЯЧат",
        subtitle: "Системный канал",
        description: "ЯЧат запущен. Здесь будут новости приложения, изменения и служебные объявления.",
        profileUsername: "yachat_channel",
        profileUrl: "https://yachat.vercel.app/yachat_channel",
        profileAbout: "Системный канал ЯЧата: новости приложения, изменения и служебные объявления.",
        profileKindLabel: "Системный канал",
        ownerId: SYSTEM_OWNER.id,
        ownerName: SYSTEM_OWNER.displayName,
        ownerUsername: SYSTEM_OWNER.username,
        locked: true,
        verified: true,
        verifiedTitle: "ЯЧат",
        verifiedDescription: "Системный канал ЯЧата. Все аккаунты подписаны автоматически; писать и чистить историю может только владелец Мурочко.",
        pinned: true,
        canSend: false,
        avatar: "channel",
        avatarDataUrl: "./assets/yachat-icon-square.png",
        createdAt
      }
    ];

    return {
      version: 1,
      chats,
      messages: {
        "yachat-favorites": [],
        "yachat-codes": [
          createMessage("yachat-codes", "Здесь будут появляться одноразовые коды подтверждения для входа, банков, магазинов и сервисов.", "bot"),
          createMessage("yachat-codes", "От этого чата нельзя отписаться: он нужен для безопасности аккаунта.", "bot")
        ],
        "yachat-channel": [
          createMessage("yachat-channel", "ЯЧат запущен. Здесь будут новости приложения, изменения и служебные объявления.", "channel"),
          createMessage("yachat-channel", "Этот системный канал встроен в ЯЧат и остаётся доступным всегда.", "channel")
        ]
      },
      updatedAt: createdAt
    };
  }

  function systemChannelAvatar(avatarDataUrl, fallbackAvatarDataUrl) {
    const value = String(avatarDataUrl || "");
    return value.includes("yachat-logo-COLOR") || value.includes("yachat-icon.svg") || value.includes("yachat-SVG-color")
      ? fallbackAvatarDataUrl
      : value || fallbackAvatarDataUrl;
  }

  function ensureSystemChats(state) {
    const fallback = createDefaultMessengerState();
    const chats = Array.isArray(state.chats) ? state.chats : [];
    const messages = state.messages && typeof state.messages === "object" ? state.messages : {};

    for (const systemChat of fallback.chats) {
      if (!chats.some((chat) => chat.id === systemChat.id)) {
        chats.push(systemChat);
      } else {
        const existing = chats.find((chat) => chat.id === systemChat.id);
        const preservedChannel = existing.id === "yachat-channel"
          ? {
              title: existing.title || systemChat.title,
              description: existing.description || systemChat.description,
              profileAbout: existing.profileAbout || existing.description || systemChat.profileAbout,
              avatarDataUrl: systemChannelAvatar(existing.avatarDataUrl, systemChat.avatarDataUrl)
            }
          : {};
        Object.assign(existing, systemChat, preservedChannel, { createdAt: existing.createdAt || systemChat.createdAt });
      }

      if (!Array.isArray(messages[systemChat.id])) {
        messages[systemChat.id] = fallback.messages[systemChat.id];
      }
    }

    for (const [chatId, list] of Object.entries(messages)) {
      if (Array.isArray(list)) {
        messages[chatId] = list
          .filter((message) => !REMOVED_TEST_MESSAGE_TEXTS.has(String(message?.text || "").trim()))
          .map((message) => {
            if (chatId === "yachat-channel" && String(message?.text || "").includes("Канал ЯЧата")) {
              return {
                ...message,
                text: String(message.text || "").replaceAll("Канал ЯЧата", "ЯЧат").replaceAll("канал встроен", "системный канал встроен")
              };
            }
            return message;
          });
      }
    }

    return {
      version: 1,
      ...state,
      chats,
      messages,
      updatedAt: state.updatedAt || new Date().toISOString()
    };
  }

  function loadMessengerState() {
    const chats = dbAll("select data_json from chats order by created_at")
      .map((row) => parseStoredJson(row.data_json, null))
      .filter(Boolean);
    const messages = {};

    for (const row of dbAll("select chat_id, data_json from messages order by created_at")) {
      const message = parseStoredJson(row.data_json, null);
      if (!message) {
        continue;
      }

      messages[row.chat_id] = [...(messages[row.chat_id] || []), message];
    }

    if (chats.length === 0) {
      return null;
    }

    return {
      version: 1,
      chats,
      messages,
      updatedAt: new Date().toISOString()
    };
  }

  function persistMessengerState(state) {
    const insertChat = db().prepare(`
      insert into chats(id, data_json, created_at, updated_at)
      values(?, ?, ?, ?)
    `);
    const insertMessage = db().prepare(`
      insert into messages(id, chat_id, data_json, created_at)
      values(?, ?, ?, ?)
    `);
    const now = new Date().toISOString();

    runInTransaction(() => {
      db().exec("delete from messages");
      db().exec("delete from chats");

      for (const chat of Array.isArray(state.chats) ? state.chats : []) {
        const chatId = String(chat?.id || "");
        if (!chatId) {
          continue;
        }

        insertChat.run(
          chatId,
          JSON.stringify(chat),
          chat.createdAt || now,
          chat.updatedAt || state.updatedAt || now
        );

        for (const message of Array.isArray(state.messages?.[chatId]) ? state.messages[chatId] : []) {
          const messageId = String(message?.id || crypto.randomUUID());
          insertMessage.run(
            messageId,
            chatId,
            JSON.stringify({ ...message, id: messageId, chatId }),
            message.createdAt || now
          );
        }
      }
    });
  }

  async function ensureMessengerState() {
    const state = ensureSystemChats(loadMessengerState() || createDefaultMessengerState());
    persistMessengerState(state);
    return state;
  }

  function countUnreadMessages(chat, list) {
    if (!chat?.manualUnread || !Array.isArray(list) || list.length === 0) {
      return 0;
    }

    const unreadMessageId = String(chat.unreadMessageId || "");
    const startIndex = unreadMessageId
      ? list.findIndex((message) => message.id === unreadMessageId)
      : -1;

    return startIndex >= 0 ? list.length - startIndex : 1;
  }

  function summarizeChat(chat, messages, account = null, usersById = new Map()) {
    const list = messages[chat.id] || [];
    const last = list[list.length - 1] || null;
    const attachment = last?.attachments?.[0] || null;
    const attachmentText = attachment?.kind === "image"
      ? "Фото"
      : attachment?.kind === "video"
        ? "Видео"
        : attachment
          ? "Файл"
          : "";
    const participantIds = chatParticipantIds(chat);
    const participantProfiles = chat.participantProfiles || {};
    let title = chat.title;
    let subtitle = chat.subtitle;
    let avatarDataUrl = chat.avatarDataUrl || "";
    let verified = Boolean(chat.verified);
    let verifiedTitle = chat.verifiedTitle || "";
    let verifiedDescription = chat.verifiedDescription || "";
    let roleLabel = chat.roleLabel || "";

    if (chat.kind === "private" && participantIds.length > 0) {
      const otherId = participantIds.find((id) => id !== account?.id) || participantIds[0];
      const other = usersById.get(otherId) || participantProfiles[otherId] || null;
      if (other) {
        title = other.displayName || other.previewName || other.username || title;
        subtitle = other.username ? `@${other.username}` : "Личный чат";
        avatarDataUrl = other.avatarDataUrl || avatarDataUrl;
        const meta = verificationFields(other);
        verified = Boolean(meta.verified);
        verifiedTitle = meta.verifiedTitle;
        verifiedDescription = meta.verifiedDescription;
        roleLabel = meta.roleLabel;
      }
    }

    if (chat.kind === "group") {
      subtitle = `${Math.max(participantIds.length, 1)} участников`;
    }

    const summary = {
      ...chat,
      participantIds,
      title,
      subtitle,
      avatarDataUrl,
      verified,
      verifiedTitle,
      verifiedDescription,
      roleLabel,
      lastMessage: last?.text || attachmentText,
      lastAt: last?.createdAt || chat.createdAt,
      unread: countUnreadMessages(chat, list)
    };

    if (chat.id === "yachat-channel") {
      const owner = findMurochkoProfile([...usersById.values()]);
      summary.canSend = isMurochkoProfile(account);
      if (owner) {
        summary.ownerId = owner.id || SYSTEM_OWNER.id;
        summary.ownerName = owner.displayName || owner.previewName || SYSTEM_OWNER.displayName;
        summary.ownerUsername = owner.username || SYSTEM_OWNER.username;
        summary.ownerAvatarDataUrl = owner.avatarDataUrl || "";
        summary.ownerAvatarAccent = owner.avatarAccent || "#471AFF";
      }
    }

    return summary;
  }

  function summarizeChatList(state, account, usersById) {
    return state.chats
      .filter((chat) => chatVisibleForAccount(chat, account))
      .map((chat) => summarizeChat(chat, state.messages, account, usersById))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }

        return String(b.lastAt || "").localeCompare(String(a.lastAt || ""));
      });
  }

  async function listChats() {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const usersById = createUserMap(await readAllManifests());
    return summarizeChatList(state, account, usersById);
  }

  function messageForAccount(message, account) {
    if (!message || !account?.id || !["user", "contact"].includes(message.author)) {
      return message;
    }

    const senderId = String(message.senderId || message.authorId || message.userId || "");
    if (!senderId) {
      return message;
    }

    return {
      ...message,
      author: senderId === account.id ? "user" : "contact"
    };
  }

  function messagesForAccount(messages, account) {
    return (Array.isArray(messages) ? messages : []).map((message) => messageForAccount(message, account));
  }

  function chatMessagesForAccount(state, chatId, account) {
    return messagesForAccount(state.messages?.[chatId] || [], account);
  }

  async function getMessages(chatId) {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const chat = state.chats.find((item) => item.id === chatId);

    if (!chat) {
      throw new Error("Чат не найден.");
    }

    return chatMessagesForAccount(state, chat.id, account);
  }

  async function saveMessengerState(state) {
    const next = {
      ...state,
      updatedAt: new Date().toISOString()
    };
    persistMessengerState(next);
    return next;
  }

  async function addSystemMessage(chatId, text, author = "bot", extra = {}) {
    const state = await ensureMessengerState();
    const chat = state.chats.find((item) => item.id === chatId);

    if (!chat) {
      return null;
    }

    const message = createMessage(chatId, text, author, extra);
    state.messages[chatId] = [...(state.messages[chatId] || []), message];
    await saveMessengerState(state);
    return message;
  }

  async function recordVerificationCode(contact, code) {
    return addSystemMessage(
      "yachat-codes",
      `Код подтверждения ЯЧата для ${contact}: ${code}. Он действует 10 минут. Никому его не сообщайте.`,
      "bot",
      { systemKind: "verification-code" }
    );
  }

  async function createChat(payload) {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const users = await readAllManifests();
    const usersById = createUserMap(users);
    const kind = payload?.kind === "group" ? "group" : "private";
    const incomingProfiles = new Map(
      Object.entries(payload?.participantProfiles && typeof payload.participantProfiles === "object" ? payload.participantProfiles : {})
        .map(([id, profile]) => payloadChatProfile(id, profile))
        .filter(Boolean)
        .map((profile) => [profile.id, profile])
    );
    const selectedIds = uniqueIds(payload?.participantIds)
      .filter((id) => id !== account?.id && (usersById.has(id) || incomingProfiles.has(id)));

    if (!account?.id) {
      throw new Error("Сначала войдите в аккаунт.");
    }

    if (kind === "private" && selectedIds.length !== 1) {
      throw new Error("Выберите одного человека для личного чата.");
    }

    if (kind === "group" && selectedIds.length < 1) {
      throw new Error("Добавьте в группу хотя бы одного человека.");
    }

    const title = kind === "group"
      ? normalizeProfileText(payload?.title, 60)
      : usersById.get(selectedIds[0])?.displayName || incomingProfiles.get(selectedIds[0])?.displayName || "Личный чат";

    if (kind === "group" && !title) {
      throw new Error("Введите название группы.");
    }

    const participantIds = [account.id, ...selectedIds];
    const participantProfiles = Object.fromEntries(
      participantIds
        .map((id) => [id, usersById.get(id) || incomingProfiles.get(id)])
        .filter(([, profile]) => profile)
    );

    if (kind === "private") {
      const pair = [...participantIds].sort().join(":");
      const existing = state.chats.find((chat) => (
        chat.kind === "private" &&
        chatParticipantIds(chat).sort().join(":") === pair
      ));

      if (existing) {
        return {
          chat: summarizeChat(existing, state.messages, account, usersById),
          chats: summarizeChatList(state, account, usersById),
          messages: chatMessagesForAccount(state, existing.id, account)
        };
      }
    }

    const now = new Date().toISOString();
    const chat = {
      id: `${kind}-${crypto.randomUUID()}`,
      kind,
      title,
      subtitle: kind === "group" ? "Группа" : "Личный чат",
      description: normalizeProfileText(payload?.description, 180),
      participantIds,
      participantProfiles,
      locked: false,
      verified: false,
      pinned: false,
      canSend: true,
      avatar: kind,
      avatarDataUrl: normalizeAvatarDataUrl(payload?.avatarDataUrl),
      ownerId: account?.id || null,
      inviteCode: null,
      inviteUrl: null,
      createdAt: now
    };

    state.chats.push(chat);
    state.messages[chat.id] = [
      createMessage(chat.id, kind === "group" ? "Группа создана." : "Чат создан.", "system")
    ];

    await saveMessengerState(state);
    return {
      chat: summarizeChat(chat, state.messages, account, usersById),
      chats: summarizeChatList(state, account, usersById),
      messages: chatMessagesForAccount(state, chat.id, account)
    };
  }

  function canManageChat(chat, account) {
    if (!chat) {
      return false;
    }

    if (chat.id === "yachat-channel") {
      return isMurochkoProfile(account);
    }

    if (chat.locked) {
      return false;
    }

    if (chat.kind !== "group") {
      return false;
    }

    return Boolean(account?.id && (!chat.ownerId || chat.ownerId === account.id));
  }

  async function updateChat(payload) {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const usersById = createUserMap(await readAllManifests());
    const chat = state.chats.find((item) => item.id === payload?.chatId);

    if (!chat) {
      throw new Error("Чат не найден.");
    }

    if (!canManageChat(chat, account)) {
      throw new Error("Нет прав на изменение этого чата.");
    }

    if (chat.kind === "group" && !chat.ownerId && account?.id) {
      chat.ownerId = account.id;
    }

    if (Object.prototype.hasOwnProperty.call(payload || {}, "title")) {
      const title = normalizeProfileText(payload.title, 60);
      if (!title) {
        throw new Error("Введите название чата.");
      }
      chat.title = title;
    }

    if (Object.prototype.hasOwnProperty.call(payload || {}, "description")) {
      chat.description = normalizeProfileText(payload.description, 180);
      if (chat.id === "yachat-channel") {
        chat.subtitle = "Системный канал";
        chat.profileAbout = chat.description || "Системный канал ЯЧата: новости приложения, изменения и служебные объявления.";
      } else if (chat.kind === "group") {
        chat.subtitle = "Группа";
        chat.profileAbout = chat.description;
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload || {}, "avatarDataUrl")) {
      chat.avatarDataUrl = normalizeAvatarDataUrl(payload.avatarDataUrl);
    }

    chat.updatedAt = new Date().toISOString();
    await saveMessengerState(state);

    return {
      chat: summarizeChat(chat, state.messages, account, usersById),
      chats: summarizeChatList(state, account, usersById),
      messages: chatMessagesForAccount(state, chat.id, account)
    };
  }

  async function createInvite(payload) {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const usersById = createUserMap(await readAllManifests());
    const chat = state.chats.find((item) => item.id === payload?.chatId);

    if (!chat) {
      throw new Error("Чат не найден.");
    }

    if (chat.kind !== "group") {
      throw new Error("Приглашения доступны только для групп.");
    }

    if (!canManageChat(chat, account)) {
      throw new Error("Только владелец группы может приглашать людей.");
    }

    if (!chat.ownerId && account?.id) {
      chat.ownerId = account.id;
    }

    chat.inviteCode = chat.inviteCode || `YC-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    chat.inviteUrl = `yachat://join/${chat.inviteCode}`;
    chat.updatedAt = new Date().toISOString();
    await saveMessengerState(state);

    return {
      chat: summarizeChat(chat, state.messages, account, usersById),
      chats: summarizeChatList(state, account, usersById),
      inviteCode: chat.inviteCode,
      inviteUrl: chat.inviteUrl
    };
  }

  async function leaveChat(payload) {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const usersById = createUserMap(await readAllManifests());
    const chat = state.chats.find((item) => item.id === payload?.chatId);

    if (!chat) {
      throw new Error("Чат не найден.");
    }

    if (chat.locked) {
      throw new Error("Из этого чата нельзя выйти.");
    }

    state.chats = state.chats.filter((item) => item.id !== chat.id);
    delete state.messages[chat.id];
    await saveMessengerState(state);
    const chats = summarizeChatList(state, account, usersById);

    return {
      chats,
      activeChatId: chats[0]?.id || null
    };
  }

  async function deleteChat(payload) {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const usersById = createUserMap(await readAllManifests());
    const chat = state.chats.find((item) => item.id === payload?.chatId);

    if (!chat) {
      throw new Error("Чат не найден.");
    }

    if (chat.kind !== "group" || chat.locked || (chat.ownerId && chat.ownerId !== account?.id)) {
      throw new Error("Удалить группу может только владелец.");
    }

    state.chats = state.chats.filter((item) => item.id !== chat.id);
    delete state.messages[chat.id];
    await saveMessengerState(state);
    const chats = summarizeChatList(state, account, usersById);

    return {
      chats,
      activeChatId: chats[0]?.id || null
    };
  }

  async function clearHistory(payload) {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const usersById = createUserMap(await readAllManifests());
    const chat = state.chats.find((item) => item.id === payload?.chatId);

    if (!chat) {
      throw new Error("Чат не найден.");
    }

    if (chat.id === "yachat-codes") {
      throw new Error("Историю этого системного чата нельзя очистить.");
    }

    if (chat.id === "yachat-channel" && !isMurochkoProfile(account)) {
      throw new Error("Историю канала ЯЧата может очистить только Мурочко.");
    }

    state.messages[chat.id] = [];
    chat.manualUnread = false;
    chat.unreadMessageId = "";
    chat.updatedAt = new Date().toISOString();
    await saveMessengerState(state);

    return {
      chats: summarizeChatList(state, account, usersById),
      messages: []
    };
  }

  async function sendMessage(payload) {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const usersById = createUserMap(await readAllManifests());
    const chat = state.chats.find((item) => item.id === payload?.chatId);
    const text = String(payload?.text || "").trim();
    const attachments = await normalizeAttachments(payload?.attachments);
    const replySource = (state.messages[chat?.id] || []).find((item) => item.id === payload?.replyToMessageId);
    const replyTo = replySource ? {
      messageId: replySource.id,
      author: replySource.author,
      text: String(replySource.text || "").slice(0, 160)
    } : null;

    if (!chat) {
      throw new Error("Чат не найден.");
    }

    if (!text && attachments.length === 0) {
      throw new Error("Введите сообщение.");
    }

    if (chat.canSend === false && !(chat.id === "yachat-channel" && isMurochkoProfile(account))) {
      throw new Error("В этот канал нельзя писать.");
    }

    const userMessage = createMessage(chat.id, text, chat.id === "yachat-channel" ? "channel" : "user", {
      senderId: account.id,
      attachments,
      ...(replyTo ? { replyTo } : {})
    });
    state.messages[chat.id] = [...(state.messages[chat.id] || []), userMessage];
    chat.manualUnread = false;
    chat.unreadMessageId = "";

    if (chat.id === "yachat-codes") {
      state.messages[chat.id].push(createMessage(
        chat.id,
        "Я принимаю только системные коды и служебные подтверждения. Обычные сообщения сохраняю здесь локально.",
        "bot"
      ));
    }

    await saveMessengerState(state);
    return {
      chats: summarizeChatList(state, account, usersById),
      messages: chatMessagesForAccount(state, chat.id, account)
    };
  }

  async function updateMessage(payload) {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const usersById = createUserMap(await readAllManifests());
    const chat = state.chats.find((item) => item.id === payload?.chatId);
    const text = String(payload?.text || "").trim();

    if (!chat) {
      throw new Error("Чат не найден.");
    }

    if (!text) {
      throw new Error("Введите сообщение.");
    }

    const message = (state.messages[chat.id] || []).find((item) => item.id === payload?.messageId);
    if (!message || (message.senderId ? message.senderId !== account?.id : message.author !== "user")) {
      throw new Error("Это сообщение нельзя редактировать.");
    }

    message.text = text;
    message.editedAt = new Date().toISOString();
    await saveMessengerState(state);
    return {
      chats: summarizeChatList(state, account, usersById),
      messages: chatMessagesForAccount(state, chat.id, account)
    };
  }

  async function deleteMessage(payload) {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const usersById = createUserMap(await readAllManifests());
    const chat = state.chats.find((item) => item.id === payload?.chatId);
    const ids = uniqueIds(payload?.messageIds || [payload?.messageId]);

    if (!chat) {
      throw new Error("Чат не найден.");
    }

    if (ids.length === 0) {
      throw new Error("Сообщение не выбрано.");
    }

    const removing = new Set(ids);
    state.messages[chat.id] = (state.messages[chat.id] || []).filter((message) => !removing.has(message.id));
    await saveMessengerState(state);
    return {
      chats: summarizeChatList(state, account, usersById),
      messages: chatMessagesForAccount(state, chat.id, account)
    };
  }

  async function markChatUnread(payload) {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const usersById = createUserMap(await readAllManifests());
    const chat = state.chats.find((item) => item.id === payload?.chatId);

    if (!chat) {
      throw new Error("Чат не найден.");
    }

    const list = state.messages[chat.id] || [];
    const messageId = String(payload?.messageId || "");
    const message = list.find((item) => item.id === messageId);

    if (!message) {
      throw new Error("Сообщение не найдено.");
    }

    chat.manualUnread = true;
    chat.unreadMessageId = message.id;
    await saveMessengerState(state);
    return {
      chats: summarizeChatList(state, account, usersById),
      messages: chatMessagesForAccount(state, chat.id, account)
    };
  }

  async function markChatRead(payload) {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const usersById = createUserMap(await readAllManifests());
    const chat = state.chats.find((item) => item.id === payload?.chatId);

    if (!chat) {
      throw new Error("Чат не найден.");
    }

    chat.manualUnread = false;
    chat.unreadMessageId = "";
    await saveMessengerState(state);
    return {
      chats: summarizeChatList(state, account, usersById),
      messages: chatMessagesForAccount(state, chat.id, account)
    };
  }

  async function forwardMessage(payload) {
    const state = await ensureMessengerState();
    const account = await getLastAccount();
    const usersById = createUserMap(await readAllManifests());
    const fromChat = state.chats.find((item) => item.id === payload?.fromChatId);
    const toChat = state.chats.find((item) => item.id === payload?.toChatId);
    const source = (state.messages[fromChat?.id] || []).find((item) => item.id === payload?.messageId);

    if (!fromChat || !toChat || !source) {
      throw new Error("Сообщение не найдено.");
    }

    if (toChat.canSend === false && !(toChat.id === "yachat-channel" && isMurochkoProfile(account))) {
      throw new Error("В этот канал нельзя писать.");
    }

    const forwarded = createMessage(toChat.id, source.text || "", "user", {
      senderId: account.id,
      attachments: Array.isArray(source.attachments) ? source.attachments : [],
      forwardedFrom: fromChat.title || ""
    });
    state.messages[toChat.id] = [...(state.messages[toChat.id] || []), forwarded];
    toChat.manualUnread = false;
    toChat.unreadMessageId = "";
    await saveMessengerState(state);
    return {
      chats: summarizeChatList(state, account, usersById),
      messages: chatMessagesForAccount(state, toChat.id, account),
      chatId: toChat.id
    };
  }

  async function getAttachmentFile(fileName) {
    const safeName = path.basename(String(fileName || ""));
    const filePath = path.join(attachmentsRoot, safeName);
    await fs.access(filePath);
    return filePath;
  }

  async function readQrSessions() {
    const rows = dbAll("select id, data_json from qr_sessions");
    const sessions = {};

    for (const row of rows) {
      const session = parseStoredJson(row.data_json, null);
      if (session) {
        sessions[row.id] = session;
      }
    }

    return {
      version: 1,
      sessions,
      updatedAt: new Date().toISOString()
    };
  }

  async function writeQrSessions(payload) {
    const insertSession = db().prepare(`
      insert into qr_sessions(id, data_json, updated_at)
      values(?, ?, ?)
      on conflict(id) do update set data_json = excluded.data_json, updated_at = excluded.updated_at
    `);
    const removeSession = db().prepare("delete from qr_sessions where id = ?");
    const sessions = payload.sessions || {};
    const ids = new Set(Object.keys(sessions));
    const now = new Date().toISOString();

    runInTransaction(() => {
      for (const row of dbAll("select id from qr_sessions")) {
        if (!ids.has(row.id)) {
          removeSession.run(row.id);
        }
      }

      for (const [id, session] of Object.entries(sessions)) {
        insertSession.run(id, JSON.stringify(session), session.updatedAt || now);
      }
    });
  }

  function parseQrPayload(payload) {
    const source = String(payload || "").trim();

    try {
      const parsed = JSON.parse(source);
      if (parsed?.a === "yc" && parsed?.t === "l" && parsed?.i && parsed?.k) {
        return {
          id: String(parsed.i),
          token: String(parsed.k)
        };
      }
    } catch {
      // Not a JSON QR token.
    }

    const match = source.match(/^yachat:\/\/login\/([^/]+)\/([^/]+)$/);

    if (!match) {
      return null;
    }

    return {
      id: match[1],
      token: match[2]
    };
  }

  async function createQrSession() {
    await init();
    const data = await readQrSessions();
    const id = crypto.randomBytes(8).toString("base64url");
    const token = crypto.randomBytes(12).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    const payload = JSON.stringify({ a: "yc", t: "l", i: id, k: token });

    data.sessions[id] = {
      id,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt
    };

    await writeQrSessions(data);

    return {
      id,
      token,
      payload,
      status: "pending",
      expiresAt
    };
  }

  async function getQrSession(payload) {
    await init();
    const parsed = parseQrPayload(payload?.payload) || {
      id: String(payload?.id || ""),
      token: String(payload?.token || "")
    };
    const data = await readQrSessions();
    const session = data.sessions[parsed.id];

    if (!session) {
      return { status: "missing" };
    }

    const tokenHash = crypto.createHash("sha256").update(parsed.token).digest("hex");
    if (tokenHash !== session.tokenHash) {
      return { status: "missing" };
    }

    if (Date.now() > new Date(session.expiresAt).getTime() && session.status === "pending") {
      session.status = "expired";
      await writeQrSessions(data);
    }

    return {
      id: session.id,
      status: session.status,
      expiresAt: session.expiresAt,
      approvedAt: session.approvedAt || null,
      account: session.status === "approved" ? await getLastAccount() : null
    };
  }

  async function confirmQrSession(payload) {
    await init();
    const parsed = parseQrPayload(payload?.payload);

    if (!parsed) {
      throw new Error("QR-код ЯЧата не распознан.");
    }

    const data = await readQrSessions();
    const session = data.sessions[parsed.id];

    if (!session) {
      throw new Error("Сессия не найдена.");
    }

    const tokenHash = crypto.createHash("sha256").update(parsed.token).digest("hex");
    if (tokenHash !== session.tokenHash) {
      throw new Error("Сессия не совпала.");
    }

    if (Date.now() > new Date(session.expiresAt).getTime()) {
      session.status = "expired";
      await writeQrSessions(data);
      throw new Error("QR-код устарел.");
    }

    const account = await getLastAccount();
    if (!account) {
      throw new Error("Сначала войдите в аккаунт.");
    }

    session.status = "approved";
    session.accountId = account.id;
    session.approvedAt = new Date().toISOString();
    await writeQrSessions(data);

    return {
      ok: true,
      status: "approved",
      account
    };
  }

  return {
    init,
    getStatus,
    getSettings,
    updateSettings,
    listUsers,
    searchUsers,
    checkUsername,
    lookupContacts,
    getLastAccount,
    findAccountByContact,
    createUser,
    updateAccount,
    logout,
    deleteProfile,
    listChats,
    getMessages,
    createChat,
    updateChat,
    createInvite,
    leaveChat,
    deleteChat,
    clearHistory,
    sendMessage,
    updateMessage,
    deleteMessage,
    markChatUnread,
    markChatRead,
    forwardMessage,
    recordVerificationCode,
    getAttachmentFile,
    createQrSession,
    getQrSession,
    confirmQrSession
  };
}

module.exports = {
  createLocalBackend
};

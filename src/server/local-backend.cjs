const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const CIPHER = "aes-256-gcm";
const KDF = "scrypt";

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
  const settingsPath = path.join(serverRoot, "settings.json");
  const chatsPath = path.join(serverRoot, "chats.json");
  const sessionsPath = path.join(serverRoot, "qr-sessions.json");
  const accountsPath = path.join(serverRoot, "accounts.json");

  const defaultSettings = {
    language: "ru",
    theme: "dark",
    country: "RU",
    countryCode: "+7",
    lastUserId: null,
    signedOut: false,
    updatedAt: null
  };

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

  async function init() {
    await migrateLegacyStorage();
    await fs.mkdir(usersRoot, { recursive: true });
    await fs.mkdir(serverRoot, { recursive: true });
    await fs.mkdir(attachmentsRoot, { recursive: true });
    const settings = await readJson(settingsPath, null);
    if (!settings) {
      await writeJson(settingsPath, {
        ...defaultSettings,
        updatedAt: new Date().toISOString()
      });
    }
    await rebuildAccountIndex();
    await ensureMessengerState();
  }

  async function getSettings() {
    await init();
    const settings = await readJson(settingsPath, defaultSettings);
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

    await writeJson(settingsPath, next);
    return next;
  }

  async function getStatus() {
    await init();
    return {
      appRoot,
      usersRoot,
      serverRoot,
      attachmentsRoot,
      settingsPath,
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
      userDir: path.join(usersRoot, manifest.folder)
    };
  }

  async function readAccountIndex() {
    const stored = await readJson(accountsPath, null);

    if (stored?.accounts && typeof stored.accounts === "object") {
      return stored;
    }

    return {
      version: 1,
      accounts: {},
      updatedAt: new Date().toISOString()
    };
  }

  async function writeAccountIndex(index) {
    await writeJson(accountsPath, {
      version: 1,
      accounts: index.accounts || {},
      updatedAt: new Date().toISOString()
    });
  }

  async function readAllManifests() {
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
      avatarDataUrl: manifest.avatarDataUrl || "",
      avatarAccent: manifest.avatarAccent || "#471AFF"
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

  async function rebuildAccountIndex() {
    const users = await readAllManifests();
    const accounts = {};

    for (const manifest of users) {
      const key = contactKey(manifest.contact);
      if (!key) {
        continue;
      }

      accounts[key] = {
        id: manifest.id,
        folder: manifest.folder,
        contact: manifest.contact,
        updatedAt: manifest.updatedAt || manifest.createdAt
      };
    }

    await writeAccountIndex({ accounts });
    return accounts;
  }

  async function findAccountByContact(contact) {
    await init();

    const key = contactKey(contact);
    if (!key) {
      return null;
    }

    let index = await readAccountIndex();
    let entry = index.accounts[key];

    if (!entry) {
      await rebuildAccountIndex();
      index = await readAccountIndex();
      entry = index.accounts[key];
    }

    if (!entry?.folder) {
      return null;
    }

    const manifest = await readManifest(path.join(usersRoot, entry.folder));
    if (!manifest || contactKey(manifest.contact) !== key) {
      await rebuildAccountIndex();
      return null;
    }

    await updateSettings({ lastUserId: manifest.id, signedOut: false });
    return accountFromManifest(manifest);
  }

  async function listUsers() {
    await init();
    return readAllManifests();
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
      userDir: path.join(usersRoot, manifest.folder)
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
    const username = safeSegment(payload.username);
    const folder = `${username}_${id.slice(0, 8)}`;
    const userDir = path.join(usersRoot, folder);
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

    await fs.mkdir(userDir, { recursive: true });
    await writeJson(path.join(userDir, "manifest.json"), manifest);
    await writeJson(path.join(userDir, "vault.enc.json"), vault);
    await rebuildAccountIndex();
    await updateSettings({ lastUserId: id, signedOut: false });

    return {
      ...account,
      encrypted: true,
      userDir
    };
  }

  async function logout() {
    await updateSettings({ lastUserId: null, signedOut: true });
    return { ok: true };
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
        locked: true,
        verified: true,
        pinned: true,
        canSend: true,
        avatar: "codes",
        avatarDataUrl: "./assets/yachat-codes-avatar.webp",
        createdAt
      },
      {
        id: "yachat-channel",
        kind: "channel",
        title: "Канал ЯЧата",
        subtitle: "Канал",
        locked: true,
        verified: true,
        pinned: true,
        canSend: false,
        avatar: "channel",
        avatarDataUrl: "./assets/yachat-logo-COLOR.png",
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
          createMessage("yachat-channel", "Канал ЯЧата запущен. Здесь будут новости приложения, изменения и служебные объявления.", "channel"),
          createMessage("yachat-channel", "Этот канал встроен в ЯЧат и остаётся доступным всегда.", "channel")
        ]
      },
      updatedAt: createdAt
    };
  }

  function ensureSystemChats(state) {
    const fallback = createDefaultMessengerState();
    const chats = Array.isArray(state.chats) ? state.chats : [];
    const messages = state.messages && typeof state.messages === "object" ? state.messages : {};

    for (const systemChat of fallback.chats) {
      if (!chats.some((chat) => chat.id === systemChat.id)) {
        chats.push(systemChat);
      } else {
        Object.assign(chats.find((chat) => chat.id === systemChat.id), systemChat);
      }

      if (!Array.isArray(messages[systemChat.id]) || messages[systemChat.id].length === 0) {
        messages[systemChat.id] = fallback.messages[systemChat.id];
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

  async function ensureMessengerState() {
    const stored = await readJson(chatsPath, null);
    const state = ensureSystemChats(stored || createDefaultMessengerState());
    await writeJson(chatsPath, state);
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

    if (chat.kind === "private" && participantIds.length > 0) {
      const otherId = participantIds.find((id) => id !== account?.id) || participantIds[0];
      const other = usersById.get(otherId) || participantProfiles[otherId] || null;
      if (other) {
        title = other.displayName || other.previewName || other.username || title;
        subtitle = other.username ? `@${other.username}` : "Личный чат";
        avatarDataUrl = other.avatarDataUrl || avatarDataUrl;
      }
    }

    if (chat.kind === "group") {
      subtitle = chat.description || `${Math.max(participantIds.length, 1)} участников`;
    }

    return {
      ...chat,
      participantIds,
      title,
      subtitle,
      avatarDataUrl,
      lastMessage: last?.text || attachmentText,
      lastAt: last?.createdAt || chat.createdAt,
      unread: countUnreadMessages(chat, list)
    };
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

  async function getMessages(chatId) {
    const state = await ensureMessengerState();
    const chat = state.chats.find((item) => item.id === chatId);

    if (!chat) {
      throw new Error("Чат не найден.");
    }

    return state.messages[chat.id] || [];
  }

  async function saveMessengerState(state) {
    const next = {
      ...state,
      updatedAt: new Date().toISOString()
    };
    await writeJson(chatsPath, next);
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
      `Код подтверждения для ${contact}: ${code}. Никому его не сообщайте.`,
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
    const selectedIds = uniqueIds(payload?.participantIds).filter((id) => id !== account?.id && usersById.has(id));

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
      : usersById.get(selectedIds[0])?.displayName || "Личный чат";

    if (kind === "group" && !title) {
      throw new Error("Введите название группы.");
    }

    const participantIds = [account.id, ...selectedIds];
    const participantProfiles = Object.fromEntries(participantIds.map((id) => [id, usersById.get(id)]).filter(([, profile]) => profile));

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
          messages: state.messages[existing.id] || []
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
      messages: state.messages[chat.id]
    };
  }

  function canManageChat(chat, account) {
    if (!chat || chat.locked) {
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
      chat.subtitle = chat.description || (chat.kind === "group" ? "Группа" : "Личный чат");
    }

    if (Object.prototype.hasOwnProperty.call(payload || {}, "avatarDataUrl")) {
      chat.avatarDataUrl = normalizeAvatarDataUrl(payload.avatarDataUrl);
    }

    chat.updatedAt = new Date().toISOString();
    await saveMessengerState(state);

    return {
      chat: summarizeChat(chat, state.messages, account, usersById),
      chats: summarizeChatList(state, account, usersById),
      messages: state.messages[chat.id] || []
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

    if (chat.canSend === false) {
      throw new Error("В этот канал нельзя писать.");
    }

    const userMessage = createMessage(chat.id, text, "user", { attachments, ...(replyTo ? { replyTo } : {}) });
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
      messages: state.messages[chat.id]
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
    if (!message || message.author !== "user") {
      throw new Error("Это сообщение нельзя редактировать.");
    }

    message.text = text;
    message.editedAt = new Date().toISOString();
    await saveMessengerState(state);
    return {
      chats: summarizeChatList(state, account, usersById),
      messages: state.messages[chat.id] || []
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
      messages: state.messages[chat.id] || []
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
      messages: state.messages[chat.id] || []
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
      messages: state.messages[chat.id] || []
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

    if (toChat.canSend === false) {
      throw new Error("В этот канал нельзя писать.");
    }

    const forwarded = createMessage(toChat.id, source.text || "", "user", {
      attachments: Array.isArray(source.attachments) ? source.attachments : [],
      forwardedFrom: fromChat.title || ""
    });
    state.messages[toChat.id] = [...(state.messages[toChat.id] || []), forwarded];
    toChat.manualUnread = false;
    toChat.unreadMessageId = "";
    await saveMessengerState(state);
    return {
      chats: summarizeChatList(state, account, usersById),
      messages: state.messages[toChat.id] || [],
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
    const stored = await readJson(sessionsPath, null);

    if (stored?.sessions && typeof stored.sessions === "object") {
      return stored;
    }

    return {
      version: 1,
      sessions: {},
      updatedAt: new Date().toISOString()
    };
  }

  async function writeQrSessions(payload) {
    await writeJson(sessionsPath, {
      version: 1,
      sessions: payload.sessions || {},
      updatedAt: new Date().toISOString()
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
    getLastAccount,
    findAccountByContact,
    createUser,
    logout,
    listChats,
    getMessages,
    createChat,
    updateChat,
    createInvite,
    leaveChat,
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

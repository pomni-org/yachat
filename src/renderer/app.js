const THEME_SEQUENCE = ["dark", "light"];
const DEFAULT_THEME = "dark";
const THEME_STORAGE_KEY = "yachat-theme";
const THEME_SOURCE_STORAGE_KEY = "yachat-theme-source";
const CHAT_MUTE_STORAGE_KEY = "yachat-muted-chat-ids";
const SYSTEM_OWNER = {
  id: "murochko",
  username: "murochko",
  displayName: "Мурочко",
  roleLabel: "Владелец",
  verified: true,
  verifiedTitle: "Мурочко",
  verifiedDescription: "Владелец ЯЧата. Этот значок подтверждает главный системный аккаунт."
};
const SYSTEM_CHAT_IDS = new Set(["yachat-favorites", "yachat-codes", "yachat-channel"]);
const PROTECTED_HISTORY_CHAT_IDS = new Set(["yachat-codes"]);
const TELEGRAM_BOT_URL = "https://t.me/code_yachatBot";
const systemThemeQuery = window.matchMedia?.("(prefers-color-scheme: dark)") || null;
let actionFeedbackTimer = null;

function systemTheme() {
  if (!systemThemeQuery) {
    return DEFAULT_THEME;
  }

  return systemThemeQuery.matches ? "dark" : "light";
}

function normalizeTheme(theme, fallback = DEFAULT_THEME) {
  return THEME_SEQUENCE.includes(theme) ? theme : fallback;
}

function normalizeThemeSource(source) {
  return source === "manual" ? "manual" : "system";
}

function storedThemeSource() {
  return normalizeThemeSource(localStorage.getItem(THEME_SOURCE_STORAGE_KEY));
}

function initialTheme() {
  return storedThemeSource() === "manual"
    ? normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY), systemTheme())
    : systemTheme();
}

function nextTheme(theme) {
  const index = THEME_SEQUENCE.indexOf(normalizeTheme(theme));
  return THEME_SEQUENCE[(index + 1) % THEME_SEQUENCE.length];
}

function loadMutedChatIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(CHAT_MUTE_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(ids) ? ids.map((id) => String(id || "").trim()).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function themeIconName(theme = state.theme) {
  if (theme === "dark") {
    return "moon";
  }

  return "sun";
}

const state = {
  screen: "phone",
  bootstrapped: false,
  previousScreen: "phone",
  challenge: null,
  verificationDeliveryMethod: "yachat",
  avatarDataUrl: "",
  account: null,
  accountTextMode: "default",
  chats: [],
  messages: [],
  activeChatId: "yachat-favorites",
  activePanel: null,
  mobileDialogOpen: false,
  newChatKind: "private",
  createChatUsers: [],
  createChatSelectedIds: [],
  chatSearchUsers: [],
  chatSearchLoading: false,
  chatSearchError: "",
  chatSearchRequestId: 0,
  pendingSearchChat: null,
  contactMatches: [],
  contactLookupMessage: "",
  contactLookupLoading: false,
  createChatSearchLoading: false,
  createChatSearchError: "",
  createChatSearchRequestId: 0,
  deleteProfileActionButton: null,
  deliveryActionButton: null,
  editingProfile: false,
  profileEditAvatarDataUrl: null,
  profileEditMessage: "",
  mutedChatIds: loadMutedChatIds(),
  pendingCreateChatAvatarDataUrl: "",
  pendingChatAvatarDataUrl: null,
  pendingAttachments: [],
  messageMenu: null,
  messagePressTimer: null,
  messagePressStart: null,
  ignoreNextMessageClick: false,
  transientMessagesByChat: new Map(),
  editingMessageId: null,
  replyToMessage: null,
  forwardMessage: null,
  selectingMessages: false,
  selectedMessageIds: new Set(),
  messengerPollTimer: null,
  notificationsReady: false,
  qrSession: null,
  qrPollTimer: null,
  qrScannerStream: null,
  qrScannerTimer: null,
  avatarCrop: null,
  theme: initialTheme(),
  themeSource: storedThemeSource(),
  language: localStorage.getItem("yachat-language") === "en" ? "en" : "ru",
  country: "RU",
  countryCode: "+7"
};

const screens = [...document.querySelectorAll("[data-screen]")];
const phoneForm = document.querySelector('[data-form="phone"]');
const codeForm = document.querySelector('[data-form="code"]');
const profileForm = document.querySelector('[data-form="profile"]');
const phoneInput = phoneForm.elements.phone;
const phoneButton = phoneForm.querySelector(".main-button");
const codeButton = codeForm.querySelector(".main-button");
const profileButton = profileForm.querySelector(".main-button");
const codeInputs = [...document.querySelectorAll(".code-grid input")];
const codeGrid = document.querySelector(".code-grid");
const countryChoice = document.querySelector("[data-country-choice]");
const countrySearch = document.querySelector("[data-country-search]");
const countryList = document.querySelector("[data-country-list]");
const deliveryButtons = [...document.querySelectorAll("[data-delivery-method]")];
const languageChoice = document.querySelector("[data-language-choice]");
const languageCurrent = document.querySelector("[data-language-current]");
const avatarInput = document.querySelector("[data-avatar-input]");
const avatarImage = document.querySelector("[data-avatar-image]");
const avatarInitial = document.querySelector("[data-avatar-initial]");
const doneAvatarImage = document.querySelector("[data-done-avatar]");
const doneAvatarInitial = document.querySelector("[data-done-initial]");
const authCard = document.querySelector("[data-auth-card]");
const messengerShell = document.querySelector("[data-messenger]");
const chatList = document.querySelector("[data-chat-list]");
const chatSearch = document.querySelector("[data-chat-search]");
const messageList = document.querySelector("[data-message-list]");
const messageForm = document.querySelector('[data-form="message"]');
const messageInput = document.querySelector("[data-message-input]");
const sendButton = document.querySelector(".send-button");
const attachmentButton = document.querySelector('[data-action="attach-file"]');
const attachmentInput = document.querySelector("[data-attachment-input]");
const stickersButton = document.querySelector('[data-action="open-stickers"]');
const attachmentTray = document.querySelector("[data-attachment-tray]");
const composerContext = document.querySelector("[data-composer-context]");
const dialogTitle = document.querySelector("[data-dialog-title]");
const dialogSubtitle = document.querySelector("[data-dialog-subtitle]");
const dialogAvatar = document.querySelector("[data-dialog-avatar]");
const dialogIntro = document.querySelector("[data-dialog-intro]");
const dialogIntroAvatar = document.querySelector("[data-dialog-intro-avatar]");
const dialogIntroTitle = document.querySelector("[data-dialog-intro-title]");
const dialogIntroText = document.querySelector("[data-dialog-intro-text]");
const sidePanel = document.querySelector("[data-side-panel]");
const panelTitle = document.querySelector("[data-panel-title]");
const panelKicker = document.querySelector("[data-panel-kicker]");
const panelBody = document.querySelector("[data-panel-body]");
const createChatModal = document.querySelector("[data-create-chat-modal]");
const createChatForm = document.querySelector('[data-form="create-chat"]');
const deliveryModal = document.querySelector("[data-delivery-modal]");
const deliveryContact = document.querySelector("[data-delivery-contact]");
const deleteProfileModal = document.querySelector("[data-delete-profile-modal]");
const deleteProfileForm = document.querySelector('[data-form="delete-profile"]');
const deleteProfileInput = document.querySelector("[data-delete-profile-input]");
const deleteProfileSubmit = document.querySelector("[data-delete-profile-submit]");
const qrCodeTarget = document.querySelector("[data-qr-code]");
const qrStatus = document.querySelector("[data-qr-status]");
const bootScreen = document.querySelector("[data-boot-screen]");
const bootText = document.querySelector("[data-boot-text]");
const errorPage = document.querySelector("[data-error-page]");
const errorCode = document.querySelector("[data-error-code]");
const errorTitle = document.querySelector("[data-error-title]");
const errorText = document.querySelector("[data-error-text]");

const secondaryScreens = new Set(["language", "country"]);
const standalonePagePaths = new Map([
  ["policy", "/privacy"],
  ["terms", "/terms"],
  ["help", "/help"]
]);
const standaloneRoutePaths = new Set(["privacy", "policy", "terms", "agreement", "help"]);
const systemRouteChatIds = new Map([
  ["verificationcodes_bot", "yachat-codes"],
  ["yachat_channel", "yachat-channel"]
]);
const yachatApi = createRuntimeYachatApi();

const COUNTRY_OPTIONS = [
  { country: "RU", name: "Россия", code: "+7", min: 10, max: 10 },
  { country: "BY", name: "Беларусь", code: "+375", min: 9, max: 9 },
  { country: "AZ", name: "Азербайджан", code: "+994", min: 9, max: 9 },
  { country: "AM", name: "Армения", code: "+374", min: 8, max: 8 },
  { country: "GE", name: "Грузия", code: "+995", min: 9, max: 9 },
  { country: "KZ", name: "Казахстан", code: "+7", min: 10, max: 10 },
  { country: "KG", name: "Кыргызстан", code: "+996", min: 9, max: 9 },
  { country: "MD", name: "Молдова", code: "+373", min: 8, max: 8 },
  { country: "TJ", name: "Таджикистан", code: "+992", min: 9, max: 9 },
  { country: "UZ", name: "Узбекистан", code: "+998", min: 9, max: 9 },
  { country: "AE", name: "ОАЭ", code: "+971", min: 9, max: 9 },
  { country: "AF", name: "Афганистан", code: "+93", min: 9, max: 9 },
  { country: "BO", name: "Боливия", code: "+591", min: 8, max: 8 },
  { country: "CD", name: "Конго - Киншаса", code: "+243", min: 9, max: 9 },
  { country: "CG", name: "Конго - Браззавиль", code: "+242", min: 9, max: 9 },
  { country: "CO", name: "Колумбия", code: "+57", min: 10, max: 10 },
  { country: "CU", name: "Куба", code: "+53", min: 8, max: 8 },
  { country: "EG", name: "Египет", code: "+20", min: 10, max: 10 },
  { country: "GD", name: "Гренада", code: "+1473", min: 7, max: 7 },
  { country: "ID", name: "Индонезия", code: "+62", min: 9, max: 12 },
  { country: "IN", name: "Индия", code: "+91", min: 10, max: 10 },
  { country: "IQ", name: "�
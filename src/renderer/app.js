const THEME_SEQUENCE = ["dark", "light"];
const DEFAULT_THEME = "dark";
const THEME_STORAGE_KEY = "yachat-theme";
const THEME_SOURCE_STORAGE_KEY = "yachat-theme-source";
const systemThemeQuery = window.matchMedia?.("(prefers-color-scheme: dark)") || null;

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

function themeIconName(theme = state.theme) {
  if (theme === "dark") {
    return "moon";
  }

  return "sun";
}

const state = {
  screen: "phone",
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
  deleteProfileActionButton: null,
  deliveryActionButton: null,
  editingProfile: false,
  profileEditAvatarDataUrl: null,
  profileEditMessage: "",
  pendingCreateChatAvatarDataUrl: "",
  pendingChatAvatarDataUrl: null,
  pendingAttachments: [],
  messageMenu: null,
  messagePressTimer: null,
  ignoreNextMessageClick: false,
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

const secondaryScreens = new Set(["language", "country"]);
const standalonePagePaths = new Map([
  ["policy", "/privacy"],
  ["terms", "/terms"],
  ["help", "/help"]
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
  { country: "IQ", name: "Ирак", code: "+964", min: 10, max: 10 },
  { country: "KH", name: "Камбоджа", code: "+855", min: 8, max: 9 },
  { country: "KN", name: "Сент-Китс и Невис", code: "+1869", min: 7, max: 7 },
  { country: "KW", name: "Кувейт", code: "+965", min: 8, max: 8 },
  { country: "LA", name: "Лаос", code: "+856", min: 8, max: 10 },
  { country: "LB", name: "Ливан", code: "+961", min: 7, max: 8 },
  { country: "MM", name: "Мьянма (Бирма)", code: "+95", min: 7, max: 10 },
  { country: "MY", name: "Малайзия", code: "+60", min: 9, max: 10 },
  { country: "NI", name: "Никарагуа", code: "+505", min: 8, max: 8 },
  { country: "PK", name: "Пакистан", code: "+92", min: 10, max: 10 },
  { country: "PW", name: "Палау", code: "+680", min: 7, max: 7 },
  { country: "QA", name: "Катар", code: "+974", min: 8, max: 8 },
  { country: "SA", name: "Саудовская Аравия", code: "+966", min: 9, max: 9 },
  { country: "TH", name: "Таиланд", code: "+66", min: 9, max: 9 },
  { country: "TM", name: "Туркменистан", code: "+993", min: 8, max: 8 },
  { country: "TR", name: "Турция", code: "+90", min: 10, max: 10 },
  { country: "TZ", name: "Танзания", code: "+255", min: 9, max: 9 },
  { country: "VE", name: "Венесуэла", code: "+58", min: 10, max: 10 },
  { country: "VN", name: "Вьетнам", code: "+84", min: 9, max: 10 },
  { country: "BR", name: "Бразилия", code: "+55", min: 10, max: 11 },
  { country: "CN", name: "Китай", code: "+86", min: 11, max: 11 },
  { country: "GM", name: "Гамбия", code: "+220", min: 7, max: 7 },
  { country: "ZA", name: "ЮАР", code: "+27", min: 9, max: 9 }
];

const COUNTRY_BY_CODE = new Map(COUNTRY_OPTIONS.map((item) => [item.country, item]));
const DEFAULT_PHONE_GROUPS = [3, 3, 2, 2];
const PHONE_GROUPS_BY_COUNTRY = Object.freeze({
  RU: [3, 3, 2, 2],
  BY: [2, 3, 2, 2],
  AZ: [2, 3, 2, 2],
  AM: [2, 3, 3],
  GE: [3, 2, 2, 2],
  KZ: [3, 3, 2, 2],
  KG: [3, 3, 3],
  MD: [2, 3, 3],
  TJ: [2, 3, 2, 2],
  UZ: [2, 3, 2, 2],
  AE: [2, 3, 4],
  AF: [2, 3, 4],
  BO: [1, 3, 4],
  CD: [3, 3, 3],
  CG: [2, 3, 4],
  CO: [3, 3, 4],
  CU: [1, 3, 4],
  EG: [2, 4, 4],
  GD: [3, 4],
  ID: (digits) => (digits.length <= 9 ? [2, 3, 4] : digits.length === 10 ? [3, 3, 4] : [3, 4, 5]),
  IN: [5, 5],
  IQ: [3, 3, 4],
  KH: (digits) => (digits.length <= 8 ? [2, 3, 3] : [2, 3, 4]),
  KN: [3, 4],
  KW: [4, 4],
  LA: (digits) => (digits.length <= 8 ? [2, 3, 3] : [2, 4, 4]),
  LB: (digits) => (digits.length <= 7 ? [1, 3, 3] : [2, 3, 3]),
  MM: (digits) => (digits.length <= 8 ? [1, 3, 4] : [1, 3, 3, 3]),
  MY: (digits) => (digits.length <= 9 ? [2, 3, 4] : [2, 4, 4]),
  NI: [4, 4],
  PK: [3, 3, 4],
  PW: [3, 4],
  QA: [4, 4],
  SA: [2, 3, 4],
  TH: [2, 3, 4],
  TM: [2, 3, 3],
  TR: [3, 3, 4],
  TZ: [3, 3, 3],
  VE: [3, 3, 4],
  VN: (digits) => (digits.length <= 9 ? [2, 3, 2, 2] : [2, 4, 4]),
  BR: (digits) => (digits.length <= 10 ? [2, 4, 4] : [2, 5, 4]),
  CN: [3, 4, 4],
  GM: [3, 4],
  ZA: [2, 3, 4]
});

const ICONS = {
  "message-circle-more": '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" /><path d="M8 12h.01" /><path d="M12 12h.01" /><path d="M16 12h.01" />',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><path d="M16 3.128a4 4 0 0 1 0 7.744" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" />',
  "users-round": '<path d="M18 21a8 8 0 0 0-16 0" /><circle cx="10" cy="8" r="5" /><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />',
  "phone-call": '<path d="M13 2a9 9 0 0 1 9 9" /><path d="M13 6a5 5 0 0 1 5 5" /><path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384" />',
  settings: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" />',
  plus: '<path d="M5 12h14" /><path d="M12 5v14" />',
  search: '<path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" />',
  "ellipsis-vertical": '<circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" />',
  paperclip: '<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />',
  smile: '<circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" x2="9.01" y1="9" y2="9" /><line x1="15" x2="15.01" y1="9" y2="9" />',
  "send-horizontal": '<path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z" /><path d="M6 12h16" />',
  pencil: '<path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />',
  reply: '<polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" />',
  forward: '<polyline points="15 17 20 12 15 7" /><path d="M4 18v-2a4 4 0 0 1 4-4h12" />',
  "message-unread": '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h7" /><path d="M19 3v6" /><path d="M16 6h6" />',
  "circle-check": '<circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />',
  trash: '<path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />',
  globe: '<circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />',
  moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />',
  sun: '<circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />',
  help: '<circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 1 1 5.82 1c0 2-3 2-3 4" /><path d="M12 17h.01" />',
  "chevron-left": '<path d="m15 18-6-6 6-6" />',
  "chevron-down": '<path d="m6 9 6 6 6-6" />',
  "shield-check": '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" />',
  "file-text": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />',
  "key-round": '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />',
  "qr-code": '<rect width="5" height="5" x="3" y="3" rx="1" /><rect width="5" height="5" x="16" y="3" rx="1" /><rect width="5" height="5" x="3" y="16" rx="1" /><path d="M21 16h-3a2 2 0 0 0-2 2v3" /><path d="M21 21v.01" /><path d="M12 7v3a2 2 0 0 1-2 2H7" /><path d="M3 12h.01" /><path d="M12 3h.01" /><path d="M12 16v.01" /><path d="M16 12h1" /><path d="M21 12v.01" /><path d="M12 21v-1" />',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />',
  video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" /><rect x="2" y="6" width="14" height="12" rx="2" />',
  file: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" />',
  "user-round": '<circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" />',
  x: '<path d="M18 6 6 18" /><path d="m6 6 12 12" />',
  check: '<path d="M20 6 9 17l-5-5" />',
  "monitor-smartphone": '<path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" /><path d="M10 19v-3.96 3.15" /><path d="M7 19h5" /><rect width="6" height="10" x="16" y="12" rx="2" />',
  "scan-line": '<path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" />',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />',
  "log-out": '<path d="m16 17 5-5-5-5" /><path d="M21 12H9" /><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />',
  palette: '<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" /><circle cx="13.5" cy="6.5" r=".5" fill="currentColor" /><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" /><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" /><circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />'
};

const ICON_CLASS_MAP = {
  "gg-globe": "globe",
  "gg-theme": () => themeIconName(),
  "gg-question": "help",
  "gg-chevron-down": "chevron-down",
  "gg-chevron-left": "chevron-left",
  "gg-shield": "shield-check",
  "gg-file": "file-text",
  "gg-phone": "phone-call",
  "gg-key": "key-round",
  "gg-qr": "qr-code",
  "gg-chat": "message-circle-more",
  "gg-contacts": "users-round",
  "gg-call": "phone-call",
  "gg-settings": "settings",
  "gg-plus": "plus",
  "gg-search": "search",
  "gg-more": "ellipsis-vertical",
  "gg-paperclip": "paperclip",
  "gg-sticker": "smile",
  "gg-send": "send-horizontal",
  "gg-x": "x"
};

function iconSvg(name, className = "lucide-icon") {
  const body = ICONS[name] || ICONS.file;
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll(".css-icon").forEach((element) => {
    const entry = Object.entries(ICON_CLASS_MAP).find(([className]) => element.classList.contains(className));
    if (!entry) {
      return;
    }

    const iconName = typeof entry[1] === "function" ? entry[1]() : entry[1];
    element.innerHTML = iconSvg(iconName);
  });
}

const translations = {
  ru: {
    appName: "ячат",
    appTitle: "ЯЧат",
    languageAria: "Язык",
    themeAria: "Переключить тему",
    helpAria: "Помощь",
    phoneTitle: "С каким номером телефона хотите войти?",
    phoneSubtitle: "Код придёт в ЯЧат или Telegram",
    phoneFieldAria: "Номер телефона",
    phonePlaceholder: "123 456 78 90",
    fieldNote: "Для входа нужен номер из России или страны из списка — нажмите на флаг, чтобы выбрать",
    login: "Войти",
    legalPrefix: "Нажимая «Войти», вы принимаете",
    policyLink: "политику конфиденциальности",
    legalAnd: "и",
    termsLink: "пользовательское соглашение",
    qrLogin: "Войти по QR-коду",
    codeTitle: "Введите код подтверждения",
    codeSentPrefix: "Код отправлен для",
    phoneFallback: "номер",
    codeGridAria: "Код проверки",
    continue: "Продолжить",
    changePhone: "Изменить номер",
    resend: "Отправить ещё раз",
    profileTitle: "Создайте профиль",
    profileSubtitle: "Аватар, имя и описание будут видны в ЯЧате",
    avatar: "Аватар",
    chooseAvatar: "Выбрать из галереи",
    name: "Имя",
    namePlaceholder: "обязательно",
    username: "Ник",
    usernamePlaceholder: "необязательно",
    bio: "Описание",
    bioPlaceholder: "Пара слов о себе",
    createAccount: "Создать аккаунт",
    back: "Назад",
    qrTitle: "Вход по QR-коду",
    qrSubtitle: "Откройте ЯЧат на телефоне и наведите камеру на код",
    qrAria: "QR-код для входа",
    accountCreated: "Аккаунт создан",
    doneDefault: "Аккаунт ЯЧата готов",
    viewData: "Посмотреть данные",
    jurisdiction: "Юрисдикция",
    policyTitle: "Политика конфиденциальности ЯЧата",
    termsTitle: "Пользовательское соглашение ЯЧата",
    helpSection: "Справка",
    helpTitle: "Помощь по входу",
    helpPhoneTitle: "Номер телефона",
    helpPhoneText: "Введите номер из списка стран. Код придёт в чат «Коды подтверждения» на другом устройстве или в привязанный Telegram-бот.",
    helpCodeTitle: "Код проверки",
    helpCodeText: "Откройте код в ЯЧате или Telegram и введите 6 цифр вручную. Если код неверный, поля подсветятся красным.",
    deliveryTitle: "Куда отправить код",
    deliveryText: "Выберите способ подтверждения для указанного номера.",
    deliveryYachat: "ЯЧат",
    deliveryYachatHint: "Бот «Коды подтверждения» на другом устройстве",
    deliveryTelegram: "Telegram",
    deliveryTelegramHint: "Привязанный бот кодов",
    helpQrTitle: "QR-вход",
    helpQrText: "Экран уже готов визуально. Реальное подтверждение через телефон подключим после авторизации на сервере.",
    localServer: "Хранилище",
    loading: "Загрузка...",
    localOnly: "локально",
    localMode: "локальный режим",
    secureStorage: "Зашифрованное локальное хранилище",
    wifiVersion: "Web-версия по Wi-Fi",
    unavailable: "Недоступно",
    encryption: "Шифрование",
    settings: "Настройки",
    languageTitle: "Язык приложения",
    russian: "Русский",
    english: "Английский",
    number: "Номер",
    countryTitle: "Страна телефона",
    countryRu: "RU +7 Россия",
    countryBy: "BY +375 Беларусь",
    countryKz: "KZ +7 Казахстан",
    countrySearchPlaceholder: "Найти страну",
    errEnterPhone: "Введите номер телефона.",
    errRequestCodeFirst: "Сначала запросите код проверки.",
    errExpiredCode: "Код устарел. Запросите новый.",
    errWrongCode: "Код не совпал.",
    errConfirmCodeFirst: "Сначала подтвердите код.",
    errName: "Введите имя.",
    errUsername: "Ник: 3-24 символа, латиница, цифры или подчёркивание.",
    errUsernameTaken: "Этот ник уже занят.",
    usernameChecking: "Проверяю ник...",
    errBio: "Описание не должно быть длиннее 140 символов.",
    errAvatar: "Не удалось открыть изображение.",
    errPhoneDigits: "Введите номер: {count} цифр.",
    errCreateCode: "Не удалось создать код.",
    errNoDelivery: "Для этого номера нет безопасного канала доставки. Откройте ЯЧат на другом устройстве или привяжите Telegram-бот.",
    errNoYachatDelivery: "На другом устройстве нет вошедшего ЯЧата для этого номера. Выберите Telegram или откройте ЯЧат на другом устройстве.",
    errNoTelegramDelivery: "Telegram не привязан к этому номеру. Откройте бот кодов ЯЧата и поделитесь своим номером.",
    errTelegramBotMissing: "Telegram-бот кодов не настроен на сервере.",
    errDeliveryFailed: "Код не удалось доставить. Попробуйте ещё раз.",
    errCodeDigits: "Нужны все 6 цифр.",
    errVerify: "Проверка сорвалась.",
    errCodeFailed: "Код не прошёл проверку.",
    errAccountCreate: "Аккаунт не создан.",
    errDatabaseUnavailable: "База пользователей на сервере недоступна. Проверьте Postgres/Neon в Vercel.",
    errDatabaseMissing: "База пользователей не настроена. Добавьте YACHAT_USERS_DB_URL или DATABASE_URL в Vercel.",
    codeDeliveryHint: "Проверьте чат «Коды подтверждения» на другом устройстве или Telegram-бот.",
    codeDeliveryYachat: "Код отправлен в чат «Коды подтверждения» на другом устройстве.",
    codeDeliveryTelegram: "Код отправлен в Telegram-бот ЯЧата.",
    codeDeliveryBoth: "Код отправлен в ЯЧат и Telegram-бот.",
    accountReady: "{name}, профиль @{username} готов.",
    accountAlready: "{name}, профиль @{username} уже создан.",
    alertAccount: "ЯЧат\n\nИмя: {name}\nНик: @{username}\nОписание: {bio}\nТелефон: {contact}\nСоздан: {createdAt}",
    chatsTitle: "Чаты",
    allChats: "Все",
    contacts: "Контакты",
    calls: "Звонки",
    yachatBot: "Коды подтверждения",
    yachatChannel: "Канал ЯЧата",
    savedMessages: "Избранное",
    savedMessagesSubtitle: "Сообщения для себя",
    botChat: "Бот",
    channelChat: "Канал",
    codesChat: "Ваши одноразовые коды от банков, магазинов и сервисов",
    search: "Найти",
    newChat: "Новый чат",
    privateChat: "Личный",
    groupChat: "Группа",
    chatName: "Название",
    privateChatTarget: "Человек",
    groupChatName: "Название группы",
    groupChatDescription: "Описание группы",
    addPeople: "Добавить участников",
    selectedPeople: "Выбраны",
    peopleSearchPlaceholder: "Номер телефона или ник",
    noPeopleFound: "Подходящих аккаунтов нет.",
    groupAvatar: "Аватар группы",
    chooseGroupAvatar: "Выбрать аватар",
    errChoosePerson: "Выберите одного человека для личного чата.",
    errChooseGroupMember: "Добавьте в группу хотя бы одного человека.",
    errGroupName: "Введите название группы.",
    create: "Создать",
    contactsEmpty: "Контакты появятся после добавления людей. Системные чаты уже закреплены.",
    contactsImportTitle: "Найти людей из контактов",
    contactsImportHint: "Разрешите доступ к контактам или вставьте номера вручную. ЯЧат покажет только тех, кто уже зарегистрирован.",
    requestContacts: "Запросить контакты",
    checkContacts: "Проверить номера",
    contactsInputPlaceholder: "+7 900 000 00 00\n+7 901 000 00 00",
    contactsFoundTitle: "Найдены в ЯЧате",
    contactsFoundCount: "Найдено: {count}",
    contactsNoMatches: "Совпадений пока нет. Добавьте номера и нажмите проверку.",
    contactsUnavailable: "Chrome на этом устройстве не дал доступ к адресной книге. Вставьте номера вручную.",
    contactsPermissionDenied: "Доступ к контактам не выдан. Можно вставить номера вручную.",
    contactsInputEmpty: "Добавьте хотя бы один номер.",
    openChat: "Открыть чат",
    callsEmpty: "Звонки пока без истории. Интерфейс готов под будущий голосовой модуль.",
    profileAndSettings: "Настройки",
    editProfile: "Изменить профиль",
    profileEditHint: "Нажмите на профиль, чтобы поменять имя, ник, аватар и описание.",
    profileSaved: "Профиль сохранён.",
    sessions: "Сессии",
    scanQr: "Сканировать QR",
    sessionsHint: "Наведите камеру на QR-код нового устройства.",
    openCamera: "Открыть камеру",
    cameraQrUnavailable: "Камера или распознавание QR недоступны в этой сборке.",
    cameraCaptureHint: "Откроется камера телефона. Сфотографируйте QR-код ЯЧата.",
    cameraCaptureScanning: "Проверяю фото с QR-кодом...",
    cameraCaptureNoQr: "QR-код на фото не распознан. Попробуйте сфотографировать крупнее.",
    cameraCaptureNoDetector: "Фото получено, но автосканер QR недоступен в этом браузере.",
    confirmLogin: "Подтвердить вход",
    logout: "Выйти из аккаунта",
    logoutConfirm: "Выйти из аккаунта ЯЧата?",
    dangerZone: "Опасная зона",
    deleteProfile: "Удалить профиль",
    deleteProfileHint: "Удаление уберёт профиль, аватар, контакты, чаты, сообщения и вложения с этого сервера.",
    deleteProfileConfirmTitle: "Подтверждение удаления",
    deleteProfileConfirmText: "Это действие нельзя отменить. Сервер удалит профиль, аватар, контакты, чаты, сообщения и вложения.",
    deleteProfileConfirm: "Введите фразу: Удалить мой профиль",
    deleteProfileConfirmPlaceholder: "Удалить мой профиль",
    deleteProfileCancel: "Отмена",
    deleteProfileConfirmAction: "Удалить навсегда",
    deleteProfileMismatch: "Фраза не совпала. Профиль не удалён.",
    deleteProfileDone: "Профиль удалён.",
    errDeleteProfile: "Не удалось удалить профиль.",
    chatInfo: "Профиль чата",
    chatTitle: "Название",
    chatDescription: "Описание",
    chatDescriptionPlaceholder: "Описание чата",
    saveChat: "Сохранить",
    saved: "Сохранено",
    leaveChat: "Выйти из чата",
    leaveChatConfirm: "Выйти из этого чата?",
    cannotLeave: "Из этого чата нельзя выйти.",
    groupOwner: "Вы владелец группы",
    ownerOnly: "Редактировать группу может только владелец.",
    privateManagedByProfiles: "Название личного чата берётся из профиля собеседника.",
    invitePeople: "Пригласить людей",
    inviteCode: "Код приглашения",
    copyInvite: "Скопировать приглашение",
    changeAvatar: "Сменить аватар",
    removeAvatar: "Убрать аватар",
    qrWaiting: "Ожидаем подтверждение на залогиненном устройстве",
    qrApproved: "Вход подтверждён",
    qrExpired: "QR-код устарел. Создайте новый.",
    qrCreate: "Создаём код входа для нового устройства",
    attachments: "Вложения",
    attachLimit: "Файл слишком большой. Лимит 8 МБ.",
    stickersSoon: "Стикеры добавим отдельной витриной. Сейчас работают файлы, фото и видео.",
    messagePlaceholder: "Сообщение",
    readonlyChannel: "Канал только для чтения",
    continueChat: "Хотите продолжить чат с {name}?",
    writeMessage: "Напишите сообщение",
    lockedChat: "Системный чат ЯЧата. Отписаться нельзя.",
    menuEdit: "Редактировать",
    menuReply: "Ответить",
    menuForward: "Переслать",
    menuMarkUnread: "Отметить непрочитанным",
    menuCopyText: "Скопировать текст",
    menuSelect: "Выбрать",
    menuDelete: "Удалить",
    editMessage: "Редактирование",
    replyMessage: "Ответ",
    forwardedMessage: "Переслано",
    forwardTitle: "Переслать в чат",
    cancel: "Отмена",
    damagedText: "Текст повреждён",
    errSendMessage: "Не удалось отправить сообщение."
  },
  en: {
    appName: "ячат",
    appTitle: "ЯЧат",
    languageAria: "Language",
    themeAria: "Toggle theme",
    helpAria: "Help",
    phoneTitle: "Which phone number do you want to use?",
    phoneSubtitle: "A code will arrive in YaChat or Telegram",
    phoneFieldAria: "Phone number",
    phonePlaceholder: "123 456 78 90",
    fieldNote: "Press the country code and choose from the list.",
    login: "Sign in",
    legalPrefix: "By pressing “Sign in”, you accept the",
    policyLink: "privacy policy",
    legalAnd: "and",
    termsLink: "user agreement",
    qrLogin: "Sign in with QR code",
    codeTitle: "Enter the verification code",
    codeSentPrefix: "Code sent for",
    phoneFallback: "phone number",
    codeGridAria: "Verification code",
    continue: "Continue",
    changePhone: "Change number",
    resend: "Send again",
    profileTitle: "Create your profile",
    profileSubtitle: "Your avatar, name, and profile description will be visible in ЯЧат",
    avatar: "Avatar",
    chooseAvatar: "Choose from gallery",
    name: "Name",
    namePlaceholder: "Yaroslav",
    username: "Username",
    usernamePlaceholder: "optional",
    bio: "Description",
    bioPlaceholder: "A few words about yourself",
    createAccount: "Create account",
    back: "Back",
    qrTitle: "QR code sign-in",
    qrSubtitle: "Open ЯЧат on your phone and point the camera at the code",
    qrAria: "Sign-in QR code",
    accountCreated: "Account created",
    doneDefault: "ЯЧат account is ready",
    viewData: "View data",
    jurisdiction: "Jurisdiction",
    policyTitle: "ЯЧат Privacy Policy",
    termsTitle: "ЯЧат User Agreement",
    helpSection: "Help",
    helpTitle: "Sign-in help",
    helpPhoneTitle: "Phone number",
    helpPhoneText: "Enter a supported phone number. The code arrives in Verification Codes on another device or in the linked Telegram bot.",
    helpCodeTitle: "Verification code",
    helpCodeText: "Open the code in YaChat or Telegram and enter the 6 digits manually. If it is wrong, the fields turn red.",
    deliveryTitle: "Where to send the code",
    deliveryText: "Choose how to confirm this phone number.",
    deliveryYachat: "YaChat",
    deliveryYachatHint: "Verification Codes bot on another device",
    deliveryTelegram: "Telegram",
    deliveryTelegramHint: "Linked code bot",
    helpQrTitle: "QR sign-in",
    helpQrText: "The screen is visually ready. Real phone confirmation will be connected after server authorization.",
    localServer: "Storage",
    loading: "Loading...",
    localOnly: "local",
    localMode: "local mode",
    secureStorage: "Encrypted local storage",
    wifiVersion: "Wi-Fi web version",
    unavailable: "Unavailable",
    encryption: "Encryption",
    settings: "Settings",
    languageTitle: "App language",
    russian: "Russian",
    english: "English",
    number: "Number",
    countryTitle: "Phone country",
    countryRu: "RU +7 Russia",
    countryBy: "BY +375 Belarus",
    countryKz: "KZ +7 Kazakhstan",
    countrySearchPlaceholder: "Search country",
    errEnterPhone: "Enter a phone number.",
    errRequestCodeFirst: "Request a verification code first.",
    errExpiredCode: "The code has expired. Request a new one.",
    errWrongCode: "The code does not match.",
    errConfirmCodeFirst: "Confirm the code first.",
    errName: "Enter a name.",
    errUsername: "Username: 3-24 characters, Latin letters, digits, or underscore.",
    errUsernameTaken: "This username is already taken.",
    usernameChecking: "Checking username...",
    errBio: "Description must be no longer than 140 characters.",
    errAvatar: "Could not open the image.",
    errPhoneDigits: "Enter a phone number: {count} digits.",
    errCreateCode: "Could not create the code.",
    errNoDelivery: "No secure delivery channel is connected for this number. Open YaChat on another device or link the Telegram bot.",
    errNoYachatDelivery: "No signed-in YaChat device is available for this number. Choose Telegram or open YaChat on another device.",
    errNoTelegramDelivery: "Telegram is not linked for this number. Start the YaChat code bot and share your phone number.",
    errTelegramBotMissing: "The Telegram code bot is not configured on the server.",
    errDeliveryFailed: "The code could not be delivered. Try again.",
    errCodeDigits: "All 6 digits are required.",
    errVerify: "Verification failed.",
    errCodeFailed: "The code did not pass verification.",
    errAccountCreate: "Account was not created.",
    errDatabaseUnavailable: "The server user database is unavailable. Check Postgres/Neon in Vercel.",
    errDatabaseMissing: "The user database is not configured. Add YACHAT_USERS_DB_URL or DATABASE_URL in Vercel.",
    codeDeliveryHint: "Check Verification Codes on another device or the Telegram bot.",
    codeDeliveryYachat: "Code sent to Verification Codes on another device.",
    codeDeliveryTelegram: "Code sent to the YaChat Telegram bot.",
    codeDeliveryBoth: "Code sent to YaChat and the Telegram bot.",
    accountReady: "{name}, profile @{username} is ready.",
    accountAlready: "{name}, profile @{username} already exists.",
    alertAccount: "ЯЧат\n\nName: {name}\nUsername: @{username}\nDescription: {bio}\nPhone: {contact}\nCreated: {createdAt}",
    chatsTitle: "Chats",
    allChats: "All",
    contacts: "Contacts",
    calls: "Calls",
    yachatBot: "Verification Codes",
    yachatChannel: "ЯЧат Channel",
    savedMessages: "Saved Messages",
    savedMessagesSubtitle: "Messages for yourself",
    botChat: "Bot",
    channelChat: "Channel",
    codesChat: "One-time codes from banks, stores, and services",
    search: "Search",
    newChat: "New chat",
    privateChat: "Private",
    groupChat: "Group",
    chatName: "Name",
    privateChatTarget: "Person",
    groupChatName: "Group name",
    groupChatDescription: "Group description",
    addPeople: "Add people",
    selectedPeople: "Selected",
    peopleSearchPlaceholder: "Phone number or username",
    noPeopleFound: "No matching accounts.",
    groupAvatar: "Group avatar",
    chooseGroupAvatar: "Choose avatar",
    errChoosePerson: "Choose one person for a private chat.",
    errChooseGroupMember: "Add at least one person to the group.",
    errGroupName: "Enter a group name.",
    create: "Create",
    contactsEmpty: "Contacts will appear after people are added. System chats are already pinned.",
    contactsImportTitle: "Find people from contacts",
    contactsImportHint: "Allow contact access or paste phone numbers manually. ЯЧат will show only people who already have an account.",
    requestContacts: "Request contacts",
    checkContacts: "Check numbers",
    contactsInputPlaceholder: "+1 555 000 0000\n+1 555 000 0001",
    contactsFoundTitle: "Found in ЯЧат",
    contactsFoundCount: "Found: {count}",
    contactsNoMatches: "No matches yet. Add numbers and run the check.",
    contactsUnavailable: "Chrome on this device did not provide address book access. Paste numbers manually.",
    contactsPermissionDenied: "Contact access was not granted. You can paste numbers manually.",
    contactsInputEmpty: "Add at least one phone number.",
    openChat: "Open chat",
    callsEmpty: "No call history yet. The screen is ready for the future voice module.",
    profileAndSettings: "Profile and settings",
    editProfile: "Edit profile",
    profileEditHint: "Click the profile to change name, username, avatar, and description.",
    profileSaved: "Profile saved.",
    sessions: "Sessions",
    scanQr: "Scan QR",
    sessionsHint: "Point the camera at the QR code on the new device.",
    openCamera: "Open camera",
    cameraQrUnavailable: "Camera or QR recognition is unavailable in this build.",
    cameraCaptureHint: "Your phone camera will open. Take a photo of the ЯЧат QR code.",
    cameraCaptureScanning: "Checking the QR photo...",
    cameraCaptureNoQr: "The QR code was not recognized. Try taking a larger, sharper photo.",
    cameraCaptureNoDetector: "Photo received, but QR auto-detection is unavailable in this browser.",
    confirmLogin: "Confirm sign-in",
    logout: "Log out",
    logoutConfirm: "Log out of the ЯЧат account?",
    dangerZone: "Danger zone",
    deleteProfile: "Delete profile",
    deleteProfileHint: "Deletion removes the profile, avatar, contacts, chats, messages, and attachments from this server.",
    deleteProfileConfirmTitle: "Confirm deletion",
    deleteProfileConfirmText: "This action cannot be undone. The server will delete the profile, avatar, contacts, chats, messages, and attachments.",
    deleteProfileConfirm: "Type this phrase: Delete my profile",
    deleteProfileConfirmPlaceholder: "Delete my profile",
    deleteProfileCancel: "Cancel",
    deleteProfileConfirmAction: "Delete forever",
    deleteProfileMismatch: "The phrase did not match. The profile was not deleted.",
    deleteProfileDone: "Profile deleted.",
    errDeleteProfile: "Could not delete the profile.",
    chatInfo: "Chat profile",
    chatTitle: "Title",
    chatDescription: "Description",
    chatDescriptionPlaceholder: "Chat description",
    saveChat: "Save",
    saved: "Saved",
    leaveChat: "Leave chat",
    leaveChatConfirm: "Leave this chat?",
    cannotLeave: "You cannot leave this chat.",
    groupOwner: "You own this group",
    ownerOnly: "Only the group owner can edit it.",
    privateManagedByProfiles: "The private chat name comes from the other person's profile.",
    invitePeople: "Invite people",
    inviteCode: "Invite code",
    copyInvite: "Copy invite",
    changeAvatar: "Change avatar",
    removeAvatar: "Remove avatar",
    qrWaiting: "Waiting for confirmation on a signed-in device",
    qrApproved: "Sign-in confirmed",
    qrExpired: "QR code has expired. Create a new one.",
    qrCreate: "Creating a sign-in code for the new device",
    attachments: "Attachments",
    attachLimit: "The file is too large. Limit is 8 MB.",
    stickersSoon: "Stickers will get their own tray. Files, photos, and videos work now.",
    messagePlaceholder: "Message",
    readonlyChannel: "Read-only channel",
    continueChat: "Want to continue chatting with {name}?",
    writeMessage: "Write a message",
    lockedChat: "Built-in ЯЧат system chat. You cannot unsubscribe.",
    menuEdit: "Edit",
    menuReply: "Reply",
    menuForward: "Forward",
    menuMarkUnread: "Mark unread",
    menuCopyText: "Copy text",
    menuSelect: "Select",
    menuDelete: "Delete",
    editMessage: "Editing",
    replyMessage: "Reply",
    forwardedMessage: "Forwarded",
    forwardTitle: "Forward to chat",
    cancel: "Cancel",
    damagedText: "Text is damaged",
    errSendMessage: "Could not send the message."
  }
};

const serverMessageKeys = new Map([
  ["Введите почту или телефон.", "errEnterPhone"],
  ["Введите номер телефона.", "errEnterPhone"],
  ["Сначала запросите код проверки.", "errRequestCodeFirst"],
  ["Код устарел. Запросите новый.", "errExpiredCode"],
  ["Код не совпал.", "errWrongCode"],
  ["Сначала подтвердите код.", "errConfirmCodeFirst"],
  ["Введите имя.", "errName"],
  ["Имя должно быть длиннее одного символа.", "errName"],
  ["Ник: 3-24 символа, латиница, цифры или подчёркивание.", "errUsername"],
  ["Этот ник уже занят.", "errUsernameTaken"],
  ["Описание не должно быть длиннее 140 символов.", "errBio"],
  ["Не удалось открыть изображение.", "errAvatar"],
  ["Enter a phone number.", "errEnterPhone"],
  ["Request a verification code first.", "errRequestCodeFirst"],
  ["The code has expired. Request a new one.", "errExpiredCode"],
  ["The code does not match.", "errWrongCode"],
  ["Confirm the code first.", "errConfirmCodeFirst"],
  ["Enter a name.", "errName"],
  ["Name must be longer than one character.", "errName"],
  ["Username: 3-24 characters, Latin letters, digits, or underscore.", "errUsername"],
  ["Username is already taken.", "errUsernameTaken"],
  ["Description must be no longer than 140 characters.", "errBio"],
  ["Could not open the image.", "errAvatar"],
  ["Users database is unavailable.", "errDatabaseUnavailable"],
  ["Users database is not configured. Set YACHAT_USERS_DB_URL or DATABASE_URL in Vercel.", "errDatabaseMissing"],
  ["Server database is not configured.", "errDatabaseMissing"],
  ["No secure delivery channel is connected for this number. Open YaChat on another device or link the Telegram bot first.", "errNoDelivery"],
  ["No signed-in YaChat device is available for this number. Choose Telegram or open YaChat on another device.", "errNoYachatDelivery"],
  ["Telegram is not linked for this number. Start the YaChat code bot and share your phone number first.", "errNoTelegramDelivery"],
  ["Telegram code bot is not configured.", "errTelegramBotMissing"],
  ["The code could not be delivered. Try again later.", "errDeliveryFailed"]
]);

const DELETE_PROFILE_CONFIRMATIONS = new Set([
  "удалить мой профиль",
  "удалить профиль",
  "удали мой профиль",
  "delete my profile",
  "delete profile",
  "delete my account",
  "remove my profile",
  "remove my account"
]);
const REMOVED_TEST_MESSAGE_TEXTS = new Set(["Приыет?"]);

function t(key, params = {}) {
  const dictionary = translations[state.language] || translations.ru;
  let text = dictionary[key] || translations.ru[key] || key;

  Object.entries(params).forEach(([name, value]) => {
    text = text.replaceAll(`{${name}}`, String(value));
  });

  return text;
}

function setText(selector, key, root = document) {
  const element = root.querySelector(selector);
  if (element) {
    element.textContent = t(key);
  }
}

function setAllText(selector, key, root = document) {
  root.querySelectorAll(selector).forEach((element) => {
    element.textContent = t(key);
  });
}

function setAttr(selector, attr, key, root = document) {
  const element = root.querySelector(selector);
  if (element) {
    element.setAttribute(attr, t(key));
  }
}

function setHtml(selector, key, root = document) {
  const element = root.querySelector(selector);
  if (element) {
    element.innerHTML = t(key);
  }
}

function setBackButtons() {
  document.querySelectorAll(".back-button").forEach((button) => {
    [...button.childNodes].forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        node.remove();
      }
    });
    button.appendChild(document.createTextNode(t("back")));
  });
}

function setCodeState(status) {
  if (!codeGrid) {
    return;
  }

  codeGrid.dataset.state = status || "idle";
}

function getProfileInitial() {
  const name = cleanDisplayText(profileForm.elements.displayName?.value || state.account?.displayName, "Я");
  return String(name).trim().slice(0, 1).toUpperCase() || "Я";
}

function setAvatarData(dataUrl) {
  state.avatarDataUrl = dataUrl || "";

  if (avatarImage && avatarInitial) {
    avatarImage.hidden = !state.avatarDataUrl;
    avatarInitial.hidden = Boolean(state.avatarDataUrl);
    if (state.avatarDataUrl) {
      avatarImage.src = state.avatarDataUrl;
    } else {
      avatarImage.removeAttribute("src");
      avatarInitial.textContent = getProfileInitial();
    }
  }
}

function renderDoneAvatar() {
  const dataUrl = state.account?.avatarDataUrl || "";
  const initial = String(cleanDisplayText(state.account?.displayName, state.account?.username || "Я")).trim().slice(0, 1).toUpperCase() || "Я";

  if (doneAvatarImage) {
    doneAvatarImage.hidden = !dataUrl;
    if (dataUrl) {
      doneAvatarImage.src = dataUrl;
    } else {
      doneAvatarImage.removeAttribute("src");
    }
  }

  if (doneAvatarInitial) {
    doneAvatarInitial.hidden = Boolean(dataUrl);
    doneAvatarInitial.textContent = initial;
  }
}

function readAvatarFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error(t("errAvatar")));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("errAvatar")));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error(t("errAvatar")));
      image.onload = () => {
        const side = 256;
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        const scale = Math.max(side / image.width, side / image.height);
        const width = image.width * scale;
        const height = image.height * scale;

        canvas.width = side;
        canvas.height = side;
        context.drawImage(image, (side - width) / 2, (side - height) / 2, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.88));
      };
      image.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

function updateSuccessText() {
  const target = document.querySelector("[data-success-text]");
  if (!target) {
    return;
  }

  if (!state.account) {
    target.textContent = t("doneDefault");
    return;
  }

  const key = state.accountTextMode === "existing" ? "accountAlready" : "accountReady";
  target.textContent = t(key, {
    name: cleanDisplayText(state.account.displayName, state.account.username || "Я"),
    username: cleanDisplayText(state.account.username, "user")
  });
  renderDoneAvatar();
}

function formatChatTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  if (sameDay) {
    return date.toLocaleTimeString(state.language === "en" ? "en-US" : "ru-RU", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  return date.toLocaleDateString(state.language === "en" ? "en-US" : "ru-RU", {
    day: "2-digit",
    month: "short"
  });
}

function getChatAvatarText(chat) {
  if (chat?.id === "yachat-favorites") {
    return "";
  }

  if (chat?.id === "yachat-codes") {
    return "Я";
  }

  if (chat?.id === "yachat-channel") {
    return "#";
  }

  return String(cleanDisplayText(chat?.title, "Я")).trim().slice(0, 1).toUpperCase() || "Я";
}

function getChatTitle(chat) {
  if (chat?.id === "yachat-favorites") {
    return t("savedMessages");
  }

  if (chat?.id === "yachat-channel") {
    return t("yachatChannel");
  }

  if (chat?.id === "yachat-codes") {
    return t("yachatBot");
  }

  const fallback = chat?.kind === "group" ? t("groupChat") : "ЯЧат";
  return cleanDisplayText(chat?.title, fallback);
}

function getChatSubtitle(chat) {
  if (chat?.id === "yachat-favorites") {
    return t("savedMessagesSubtitle");
  }

  if (chat?.id === "yachat-channel") {
    return t("channelChat");
  }

  if (chat?.id === "yachat-codes") {
    return cleanDisplayText(chat?.description, t("codesChat"));
  }

  const fallback = chat?.kind === "group"
    ? t("groupChat")
    : chat?.kind === "channel"
      ? t("channelChat")
      : chat?.kind === "bot"
        ? t("botChat")
        : t("privateChat");
  return cleanDisplayText(chat?.description || chat?.subtitle, fallback);
}

function getChatAvatarModifier(chat) {
  return chat?.id === "yachat-favorites"
    ? " is-favorites"
    : chat?.id === "yachat-channel"
    ? " is-channel"
    : chat?.id === "yachat-codes"
      ? " is-bot"
      : chat?.kind === "group"
        ? " is-group"
        : " is-private";
}

function renderVerified(chat) {
  return chat?.verified ? '<img class="verified-mark" src="./assets/verified-badge.png" alt="Верифицирован" />' : "";
}

function setComposerReadonly(readonly) {
  const disabled = Boolean(readonly);
  messageForm?.classList.toggle("is-readonly", disabled);
  [attachmentButton, stickersButton, attachmentInput].forEach((control) => {
    if (control) {
      control.disabled = disabled;
    }
  });
}

function renderChatAvatar(chat, className = "chat-avatar") {
  const modifier = getChatAvatarModifier(chat);
  const avatar = chat?.avatarDataUrl
    ? `<img src="${escapeHtml(chat.avatarDataUrl)}" alt="" />`
    : escapeHtml(getChatAvatarText(chat));
  return `<div class="${className}${modifier}">${avatar}</div>`;
}

function getPrivateChatParticipantId(chat) {
  if (chat?.kind !== "private" || !Array.isArray(chat.participantIds)) {
    return "";
  }

  const accountId = String(state.account?.id || "");
  return chat.participantIds
    .map((id) => String(id || "").trim())
    .find((id) => id && id !== accountId) || "";
}

function findPrivateChatForUser(userId) {
  const targetId = String(userId || "").trim();

  if (!targetId) {
    return null;
  }

  return state.chats.find((chat) => getPrivateChatParticipantId(chat) === targetId) || null;
}

function chatSearchValue() {
  return String(chatSearch?.value || "").trim();
}

function chatSearchText(chat) {
  const profileText = Object.values(chat?.participantProfiles || {})
    .map((profile) => userSearchText(profile))
    .join(" ");

  return `${getChatTitle(chat)} ${getChatSubtitle(chat)} ${chat?.lastMessage || ""} ${profileText}`.toLowerCase();
}

function getChatSearchMatches(query = chatSearchValue().toLowerCase()) {
  return state.chats.filter((chat) => !query || chatSearchText(chat).includes(query));
}

function shouldSearchUserDirectory(query, chats) {
  const value = String(query || "").trim();

  if (!value || chats.length > 0) {
    return false;
  }

  return value.length >= 2 || digitsOnly(value).length >= 3;
}

function createPendingSearchChat(user) {
  const profile = contactProfilePayload(normalizeUser(user));
  const participantProfiles = {
    [profile.id]: profile
  };

  if (state.account?.id) {
    participantProfiles[state.account.id] = {
      id: state.account.id,
      username: state.account.username,
      displayName: state.account.displayName,
      previewName: state.account.displayName,
      avatarDataUrl: state.account.avatarDataUrl || "",
      avatarAccent: state.account.avatarAccent || "#471AFF"
    };
  }

  return {
    id: `search-user-${profile.id}`,
    kind: "private",
    title: profile.displayName || profile.username || t("privateChat"),
    subtitle: profile.username ? `@${profile.username}` : t("privateChat"),
    participantIds: [state.account?.id, profile.id].filter(Boolean),
    participantProfiles,
    locked: false,
    verified: false,
    pinned: false,
    canSend: true,
    avatar: "private",
    avatarDataUrl: profile.avatarDataUrl || "",
    createdAt: new Date().toISOString(),
    lastMessage: "",
    pendingSearchUserId: profile.id,
    pendingSearchUser: profile
  };
}

function getActiveChat() {
  if (state.pendingSearchChat?.id === state.activeChatId) {
    return state.pendingSearchChat;
  }

  return state.chats.find((chat) => chat.id === state.activeChatId) || state.chats[0] || null;
}

function setMobileDialogOpen(isOpen) {
  state.mobileDialogOpen = Boolean(isOpen);
  document.body.classList.toggle("mobile-dialog-open", state.mobileDialogOpen);
}

function canOwnActiveGroup(chat) {
  return Boolean(chat?.kind === "group" && state.account?.id && (!chat.ownerId || chat.ownerId === state.account.id));
}

function canEditActiveChat(chat) {
  if (!chat || chat.locked) {
    return false;
  }

  if (chat.kind === "group") {
    return canOwnActiveGroup(chat);
  }

  return false;
}

function unreadCountLabel(chat) {
  const count = Number.parseInt(chat?.unread, 10);
  return Number.isFinite(count) && count > 0 ? String(count) : "";
}

function renderChatList() {
  if (!chatList) {
    return;
  }

  const rawQuery = chatSearchValue();
  const query = rawQuery.toLowerCase();
  const chats = getChatSearchMatches(query);
  const chatRows = chats.map((chat) => {
    const unread = unreadCountLabel(chat);
    return `
      <button class="chat-row${chat.id === state.activeChatId ? " is-active" : ""}" type="button" data-chat-id="${chat.id}">
        ${renderChatAvatar(chat)}
        <span class="chat-row-main">
          <span class="chat-row-top">
            <strong>${escapeHtml(getChatTitle(chat))} ${renderVerified(chat)}</strong>
            <time>${escapeHtml(formatChatTime(chat.lastAt))}</time>
          </span>
          <span class="chat-row-bottom">
            <span>${escapeHtml(cleanDisplayText(chat.lastMessage, getChatSubtitle(chat)))}</span>
          </span>
        </span>
        ${unread ? `<b class="chat-unread-badge">${escapeHtml(unread)}</b>` : chat.locked ? '<i class="pin-dot"></i>' : ""}
      </button>
    `;
  }).join("");
  const directoryRows = shouldSearchUserDirectory(rawQuery, chats)
    ? renderChatSearchUsers()
    : "";

  chatList.innerHTML = `${chatRows}${directoryRows}`;
}

function renderActiveChat() {
  const chat = getActiveChat();

  if (!chat || !dialogTitle) {
    return;
  }

  dialogTitle.innerHTML = `${escapeHtml(getChatTitle(chat))} ${renderVerified(chat)}`;
  dialogSubtitle.textContent = getChatSubtitle(chat);
  const avatarModifier = getChatAvatarModifier(chat);
  const avatarContent = chat.avatarDataUrl
    ? `<img src="${escapeHtml(chat.avatarDataUrl)}" alt="" />`
    : escapeHtml(getChatAvatarText(chat));
  dialogAvatar.className = `dialog-avatar${avatarModifier}`;
  dialogAvatar.innerHTML = avatarContent;
  dialogIntroAvatar.innerHTML = avatarContent;
  dialogIntroAvatar.className = `dialog-intro-avatar${avatarModifier}`;
  dialogIntroTitle.textContent = chat.id === "yachat-favorites"
    ? getChatTitle(chat)
    : t("continueChat", { name: getChatTitle(chat) });
  dialogIntroText.textContent = chat.id === "yachat-favorites"
    ? getChatSubtitle(chat)
    : chat.locked ? t("lockedChat") : t("writeMessage");
  if (dialogIntro) {
    dialogIntro.hidden = state.messages.length > 0;
  }

  const readonly = chat.canSend === false;
  if (readonly && state.pendingAttachments.length > 0) {
    state.pendingAttachments = [];
    renderAttachmentTray();
  }
  setComposerReadonly(readonly);

  if (messageInput && sendButton) {
    messageInput.disabled = readonly;
    messageInput.placeholder = readonly ? t("readonlyChannel") : t("messagePlaceholder");
    sendButton.disabled = readonly || (!messageInput.value.trim() && state.pendingAttachments.length === 0);
  }
}

function formatFileSize(size) {
  const value = Number(size) || 0;
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} МБ`;
  }
  if (value >= 1024) {
    return `${Math.ceil(value / 1024)} КБ`;
  }
  return `${value} Б`;
}

function renderAttachment(attachment) {
  const name = escapeHtml(attachment.name || "file");
  const size = escapeHtml(formatFileSize(attachment.size));
  const dataUrl = attachment.dataUrl || attachment.url || "";

  if (attachment.kind === "image" && dataUrl) {
    return `<figure class="message-attachment is-image"><img src="${escapeHtml(dataUrl)}" alt="${name}" /><figcaption>${name}</figcaption></figure>`;
  }

  if (attachment.kind === "video" && dataUrl) {
    return `<figure class="message-attachment is-video"><video src="${escapeHtml(dataUrl)}" controls></video><figcaption>${name}</figcaption></figure>`;
  }

  return `
    <div class="message-attachment is-file">
      <span>${iconSvg("file")}</span>
      <strong>${name}</strong>
      <small>${size}</small>
    </div>
  `;
}

function messagePreviewText(message) {
  const text = cleanDisplayText(message?.text, "");
  if (text) {
    return text;
  }

  const attachment = Array.isArray(message?.attachments) ? message.attachments[0] : null;
  if (attachment?.kind === "image") {
    return state.language === "en" ? "Photo" : "Фото";
  }
  if (attachment?.kind === "video") {
    return state.language === "en" ? "Video" : "Видео";
  }
  if (attachment) {
    return state.language === "en" ? "File" : "Файл";
  }

  return "";
}

function renderMessageReference(message, className = "message-reference") {
  if (!message) {
    return "";
  }

  const text = messagePreviewText(message) || t("messagePlaceholder");
  const author = message.author === "user"
    ? cleanDisplayText(state.account?.displayName, state.account?.username || "Вы")
    : getChatTitle(getActiveChat());

  return `
    <div class="${className}">
      <strong>${escapeHtml(author)}</strong>
      <span>${escapeHtml(text)}</span>
    </div>
  `;
}

function formatMessageDayLabel(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return state.language === "en" ? "Today" : "Сегодня";
  }

  if (date.toDateString() === yesterday.toDateString()) {
    return state.language === "en" ? "Yesterday" : "Вчера";
  }

  return date.toLocaleDateString(state.language === "en" ? "en-US" : "ru-RU", {
    day: "numeric",
    month: "long"
  });
}

function renderMessages() {
  if (!messageList) {
    return;
  }

  let lastDay = "";
  const items = [];

  state.messages.forEach((message) => {
    const mine = message.author === "user";
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const text = cleanDisplayText(message.text, message.text ? t("damagedText") : "");
    const selected = state.selectedMessageIds.has(message.id);
    const date = new Date(message.createdAt);
    const dayKey = Number.isNaN(date.valueOf()) ? "" : date.toDateString();
    const timeHtml = `
      <time>
        ${escapeHtml(formatChatTime(message.createdAt))}
        ${mine ? '<span class="message-status" aria-hidden="true">✓</span>' : ""}
      </time>
    `;

    if (dayKey && dayKey !== lastDay) {
      lastDay = dayKey;
      items.push(`<div class="message-day">${escapeHtml(formatMessageDayLabel(message.createdAt))}</div>`);
    }

    items.push(`
      <article class="message-bubble${mine ? " is-mine" : ""}${selected ? " is-selected" : ""}" data-message-id="${escapeHtml(message.id)}">
        ${message.forwardedFrom ? `<div class="message-forwarded">${escapeHtml(t("forwardedMessage"))}</div>` : ""}
        ${message.replyTo ? renderMessageReference(message.replyTo) : ""}
        ${text ? `<p>${escapeHtml(text)}</p>` : ""}
        ${attachments.map(renderAttachment).join("")}
        ${timeHtml}
      </article>
    `);
  });

  messageList.innerHTML = items.join("");

  requestAnimationFrame(() => {
    messageList.scrollTop = messageList.scrollHeight;
  });
}

function getMessageById(messageId) {
  return state.messages.find((message) => message.id === messageId) || null;
}

function canEditMessage(message) {
  const chat = getActiveChat();
  return Boolean(message?.author === "user" && chat?.canSend !== false && messagePreviewText(message));
}

function ensureMessageMenu() {
  let menu = document.querySelector("[data-message-menu]");
  if (menu) {
    return menu;
  }

  menu = document.createElement("div");
  menu.className = "message-context-menu";
  menu.dataset.messageMenu = "";
  menu.hidden = true;
  document.body.append(menu);
  return menu;
}

function closeMessageMenu() {
  state.messageMenu = null;
  const menu = document.querySelector("[data-message-menu]");
  if (menu) {
    menu.hidden = true;
    menu.innerHTML = "";
  }
}

function openMessageMenu(messageId, x, y) {
  const message = getMessageById(messageId);
  if (!message) {
    return;
  }

  const items = [
    canEditMessage(message) ? ["edit", "pencil", t("menuEdit")] : null,
    ["reply", "reply", t("menuReply")],
    ["forward", "forward", t("menuForward")],
    ["unread", "message-unread", t("menuMarkUnread")],
    ["copy", "copy", t("menuCopyText")],
    ["select", "circle-check", t("menuSelect")],
    ["delete", "trash", t("menuDelete"), "is-danger"]
  ].filter(Boolean);
  const menu = ensureMessageMenu();

  state.messageMenu = { messageId };
  menu.innerHTML = items.map(([action, icon, label, dangerClass]) => `
    <button class="${dangerClass || ""}" type="button" data-message-action="${action}">
      ${iconSvg(icon)}
      <span>${escapeHtml(label)}</span>
    </button>
  `).join("");
  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top = "0px";

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    const left = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8);
    const top = Math.min(Math.max(8, y), window.innerHeight - rect.height - 8);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  });
}

function clearMessageSelection() {
  state.selectingMessages = false;
  state.selectedMessageIds.clear();
  renderMessages();
}

function toggleSelectedMessage(messageId) {
  state.selectingMessages = true;
  if (state.selectedMessageIds.has(messageId)) {
    state.selectedMessageIds.delete(messageId);
  } else {
    state.selectedMessageIds.add(messageId);
  }
  if (state.selectedMessageIds.size === 0) {
    state.selectingMessages = false;
  }
  renderMessages();
}

function resetComposerMode() {
  state.editingMessageId = null;
  state.replyToMessage = null;
  renderComposerContext();
}

function startEditMessage(message) {
  if (!canEditMessage(message)) {
    return;
  }

  state.editingMessageId = message.id;
  state.replyToMessage = null;
  state.pendingAttachments = [];
  renderAttachmentTray();
  renderComposerContext();
  if (messageInput) {
    messageInput.value = messagePreviewText(message);
    messageInput.focus();
    messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
  }
  if (sendButton) {
    sendButton.disabled = !messageInput?.value.trim();
  }
}

function startReplyMessage(message) {
  state.replyToMessage = {
    messageId: message.id,
    author: message.author,
    text: messagePreviewText(message)
  };
  state.editingMessageId = null;
  renderComposerContext();
  messageInput?.focus();
}

function renderComposerContext() {
  if (!composerContext) {
    return;
  }

  const editing = state.editingMessageId ? getMessageById(state.editingMessageId) : null;
  const reference = editing
    ? { author: "user", text: messagePreviewText(editing) }
    : state.replyToMessage;

  if (!reference) {
    composerContext.hidden = true;
    composerContext.innerHTML = "";
    return;
  }

  composerContext.hidden = false;
  composerContext.innerHTML = `
    <div>
      <strong>${escapeHtml(editing ? t("editMessage") : t("replyMessage"))}</strong>
      <span>${escapeHtml(reference.text || t("messagePlaceholder"))}</span>
    </div>
    <button type="button" data-action="cancel-message-mode" aria-label="${escapeHtml(t("cancel"))}">
      ${iconSvg("x")}
    </button>
  `;
}

async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) {
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function deleteMessages(messageIds) {
  const chat = getActiveChat();
  const ids = [...new Set(messageIds)].filter(Boolean);
  if (!chat || ids.length === 0 || !yachatApi.messenger?.deleteMessage) {
    return;
  }

  const result = await yachatApi.messenger.deleteMessage({
    chatId: chat.id,
    messageIds: ids
  });
  state.chats = result.chats || await yachatApi.messenger.chats();
  state.messages = result.messages || await yachatApi.messenger.messages(chat.id);
  ids.forEach((id) => state.selectedMessageIds.delete(id));
  if (state.editingMessageId && ids.includes(state.editingMessageId)) {
    state.editingMessageId = null;
  }
  if (state.replyToMessage && ids.includes(state.replyToMessage.messageId)) {
    state.replyToMessage = null;
  }
  state.selectingMessages = state.selectedMessageIds.size > 0;
  renderComposerContext();
  renderChatList();
  renderActiveChat();
  renderMessages();
}

async function markMessageUnread(messageId) {
  const chat = getActiveChat();
  if (!chat || !yachatApi.messenger?.markUnread) {
    return;
  }

  const result = await yachatApi.messenger.markUnread({ chatId: chat.id, messageId });
  state.chats = result.chats || await yachatApi.messenger.chats();
  renderChatList();
}

function ensureForwardPicker() {
  let layer = document.querySelector("[data-forward-picker]");
  if (layer) {
    return layer;
  }

  layer = document.createElement("div");
  layer.className = "forward-picker-layer";
  layer.dataset.forwardPicker = "";
  layer.hidden = true;
  document.body.append(layer);
  return layer;
}

function closeForwardPicker() {
  state.forwardMessage = null;
  const layer = document.querySelector("[data-forward-picker]");
  if (layer) {
    layer.hidden = true;
    layer.innerHTML = "";
  }
}

function renderForwardPicker() {
  const layer = ensureForwardPicker();
  if (!state.forwardMessage) {
    closeForwardPicker();
    return;
  }

  const chats = state.chats.filter((chat) => chat.canSend !== false);
  layer.hidden = false;
  layer.innerHTML = `
    <div class="forward-picker-card">
      <header>
        <h3>${escapeHtml(t("forwardTitle"))}</h3>
        <button type="button" data-forward-close aria-label="${escapeHtml(t("cancel"))}">${iconSvg("x")}</button>
      </header>
      <div class="forward-chat-list">
        ${chats.map((chat) => `
          <button type="button" data-forward-chat="${escapeHtml(chat.id)}">
            ${renderChatAvatar(chat, "panel-row-avatar")}
            <span>
              <strong>${escapeHtml(getChatTitle(chat))}</strong>
              <small>${escapeHtml(getChatSubtitle(chat))}</small>
            </span>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

async function forwardMessageTo(chatId) {
  if (!state.forwardMessage || !yachatApi.messenger?.forwardMessage) {
    return;
  }

  const result = await yachatApi.messenger.forwardMessage({
    fromChatId: state.forwardMessage.chatId,
    messageId: state.forwardMessage.messageId,
    toChatId: chatId
  });
  closeForwardPicker();
  state.chats = result.chats || await yachatApi.messenger.chats();
  state.activeChatId = result.chatId || chatId;
  state.messages = result.messages || await yachatApi.messenger.messages(state.activeChatId);
  setMobileDialogOpen(true);
  renderChatList();
  renderActiveChat();
  renderMessages();
}

async function handleMessageAction(action) {
  const messageId = state.messageMenu?.messageId;
  const message = messageId ? getMessageById(messageId) : null;
  if (!message) {
    closeMessageMenu();
    return;
  }

  closeMessageMenu();

  try {
    if (action === "edit") {
      startEditMessage(message);
    } else if (action === "reply") {
      startReplyMessage(message);
    } else if (action === "forward") {
      state.forwardMessage = { chatId: getActiveChat()?.id, messageId: message.id };
      renderForwardPicker();
    } else if (action === "unread") {
      await markMessageUnread(message.id);
    } else if (action === "copy") {
      await copyTextToClipboard(messagePreviewText(message));
    } else if (action === "select") {
      toggleSelectedMessage(message.id);
    } else if (action === "delete") {
      const selected = state.selectedMessageIds.size > 0 && state.selectedMessageIds.has(message.id)
        ? [...state.selectedMessageIds]
        : [message.id];
      await deleteMessages(selected);
    }
  } catch (error) {
    alert(translatedServerMessage(error.message, "errSendMessage"));
  }
}

function readAttachmentFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error(t("errSendMessage")));
      return;
    }

    if (file.size > 8 * 1024 * 1024) {
      reject(new Error(t("attachLimit")));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("errSendMessage")));
    reader.onload = () => {
      const mime = file.type || "application/octet-stream";
      resolve({
        id: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `att-${Date.now()}-${Math.random()}`,
        name: file.name || "file",
        mime,
        kind: mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file",
        size: file.size,
        dataUrl: String(reader.result || "")
      });
    };
    reader.readAsDataURL(file);
  });
}

function renderAttachmentTray() {
  if (!attachmentTray) {
    return;
  }

  attachmentTray.hidden = state.pendingAttachments.length === 0;
  attachmentTray.innerHTML = state.pendingAttachments.map((attachment) => `
    <button class="attachment-chip" type="button" data-remove-attachment="${escapeHtml(attachment.id)}" title="${escapeHtml(attachment.name)}">
      ${iconSvg(attachment.kind === "image" ? "image" : attachment.kind === "video" ? "video" : "file")}
      <span>${escapeHtml(attachment.name)}</span>
    </button>
  `).join("");

  const chat = getActiveChat();
  if (sendButton) {
    sendButton.disabled = chat?.canSend === false || (!messageInput.value.trim() && state.pendingAttachments.length === 0);
  }
}

async function addAttachments(files) {
  if (getActiveChat()?.canSend === false) {
    if (attachmentInput) {
      attachmentInput.value = "";
    }
    return;
  }

  const selected = [...(files || [])].slice(0, 8 - state.pendingAttachments.length);

  try {
    const next = await Promise.all(selected.map(readAttachmentFile));
    state.pendingAttachments = [...state.pendingAttachments, ...next].slice(0, 8);
    renderAttachmentTray();
  } catch (error) {
    alert(error.message || t("errSendMessage"));
  } finally {
    if (attachmentInput) {
      attachmentInput.value = "";
    }
  }
}

async function loadMessenger(selectedChatId = state.activeChatId) {
  if (!yachatApi.messenger) {
    return;
  }

  state.pendingSearchChat = null;
  state.chats = await yachatApi.messenger.chats();
  state.activeChatId = state.chats.some((chat) => chat.id === selectedChatId)
    ? selectedChatId
    : state.chats[0]?.id || "yachat-codes";
  state.messages = await yachatApi.messenger.messages(state.activeChatId);
  renderComposerContext();
  renderChatList();
  renderActiveChat();
  renderMessages();
}

function chatIdFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get("chat") || "";
  } catch {
    return "";
  }
}

function stopMessengerPolling() {
  window.clearTimeout(state.messengerPollTimer);
  state.messengerPollTimer = null;
}

async function refreshMessengerFromServer() {
  if (!state.account || !yachatApi.messenger || state.pendingSearchChat) {
    return;
  }

  const selectedChatId = state.activeChatId;
  const chats = await yachatApi.messenger.chats();
  state.chats = chats;
  state.activeChatId = chats.some((chat) => chat.id === selectedChatId)
    ? selectedChatId
    : chats[0]?.id || state.activeChatId;
  state.messages = state.activeChatId
    ? await yachatApi.messenger.messages(state.activeChatId)
    : [];
  renderChatList();
  renderActiveChat();
  renderMessages();
}

function startMessengerPolling() {
  stopMessengerPolling();

  const tick = async () => {
    try {
      await refreshMessengerFromServer();
    } catch {
      // Keep the UI alive during transient serverless cold starts or network loss.
    } finally {
      if (state.account) {
        state.messengerPollTimer = window.setTimeout(tick, 4000);
      }
    }
  };

  state.messengerPollTimer = window.setTimeout(tick, 4000);
}

async function selectChat(chatId) {
  closeMessageMenu();
  closeForwardPicker();
  state.editingMessageId = null;
  state.replyToMessage = null;
  state.selectedMessageIds.clear();
  state.selectingMessages = false;
  state.pendingSearchChat = null;
  state.activeChatId = chatId;
  state.messages = await yachatApi.messenger.messages(chatId);
  if (yachatApi.messenger?.markRead) {
    const result = await yachatApi.messenger.markRead({ chatId });
    state.chats = result.chats || state.chats;
  }
  renderComposerContext();
  setMobileDialogOpen(true);
  renderChatList();
  renderActiveChat();
  renderMessages();
}

function showMessenger(account) {
  state.account = normalizeAccount(account);
  document.body.classList.add("messenger-mode");
  setMobileDialogOpen(false);

  if (authCard) {
    authCard.hidden = true;
  }

  if (messengerShell) {
    messengerShell.hidden = false;
  }

  loadMessenger(chatIdFromUrl() || state.activeChatId).catch(() => {});
  startMessengerPolling();
  enablePushNotifications().catch(() => {});
}

function resetAccountSessionUi() {
  stopQrPolling();
  stopQrScanner();
  stopMessengerPolling();
  closePanel();
  closeCreateChat();
  state.account = null;
  state.accountTextMode = "default";
  state.chats = [];
  state.messages = [];
  state.activeChatId = "yachat-codes";
  state.pendingSearchChat = null;
  state.chatSearchUsers = [];
  state.chatSearchLoading = false;
  state.chatSearchError = "";
  state.notificationsReady = false;
  state.pendingAttachments = [];
  setMobileDialogOpen(false);
  renderAttachmentTray();
  document.body.classList.remove("messenger-mode");

  if (messengerShell) {
    messengerShell.hidden = true;
  }

  if (authCard) {
    authCard.hidden = false;
  }

  setScreen("phone", { focusPhone: true });
}

async function logoutAccount() {
  if (!window.confirm(t("logoutConfirm"))) {
    return;
  }

  try {
    await yachatApi.account.logout?.();
  } catch {
    // UI logout still happens even if the local endpoint is already closed.
  }

  resetAccountSessionUi();
}

function normalizeDeleteProfileConfirmation(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

function isDeleteProfileConfirmation(value) {
  return DELETE_PROFILE_CONFIRMATIONS.has(normalizeDeleteProfileConfirmation(value));
}

function closeDeleteProfileConfirm() {
  if (deleteProfileModal) {
    deleteProfileModal.hidden = true;
  }

  state.deleteProfileActionButton = null;

  if (deleteProfileForm) {
    deleteProfileForm.reset();
  }

  setMessage("delete-profile", "");
}

function openDeleteProfileConfirm(actionButton) {
  if (!deleteProfileModal || !deleteProfileForm) {
    return;
  }

  state.deleteProfileActionButton = actionButton || null;
  deleteProfileForm.reset();
  setMessage("delete-profile", "");
  deleteProfileModal.hidden = false;
  requestAnimationFrame(() => deleteProfileInput?.focus());
}

async function submitDeleteProfileConfirm() {
  const phrase = deleteProfileInput?.value || "";

  if (!isDeleteProfileConfirmation(phrase)) {
    setMessage("delete-profile", t("deleteProfileMismatch"));
    return;
  }

  const actionButton = state.deleteProfileActionButton;

  if (actionButton) {
    actionButton.disabled = true;
  }

  if (deleteProfileSubmit) {
    deleteProfileSubmit.disabled = true;
  }

  try {
    await yachatApi.account.deleteProfile?.();
    closeDeleteProfileConfirm();
    resetAccountSessionUi();
    setMessage("phone", t("deleteProfileDone"));
  } catch (error) {
    setMessage("delete-profile", translatedServerMessage(error.message, "errDeleteProfile"));
  } finally {
    if (actionButton) {
      actionButton.disabled = false;
    }

    if (deleteProfileSubmit) {
      deleteProfileSubmit.disabled = false;
    }
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanDisplayText(value, fallback = "") {
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

function normalizeAccount(account) {
  if (!account) {
    return null;
  }

  const username = cleanDisplayText(account.username, "user");

  return {
    ...account,
    username,
    displayName: cleanDisplayText(account.displayName, username || "Я"),
    bio: cleanDisplayText(account.bio, "")
  };
}

function normalizeUser(user) {
  if (!user) {
    return null;
  }

  const username = cleanDisplayText(user.username, "user");
  const displayName = cleanDisplayText(user.displayName || user.previewName, username);

  return {
    ...user,
    username,
    displayName,
    previewName: displayName,
    contact: cleanDisplayText(user.contact, ""),
    matchedContact: cleanDisplayText(user.matchedContact, ""),
    avatarDataUrl: user.avatarDataUrl || "",
    avatarAccent: user.avatarAccent || "#471AFF"
  };
}

function contactMatchKeys(value) {
  const digits = digitsOnly(value);
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

function extractContactPhones(value) {
  const matches = String(value || "").match(/\+?\d[\d\s().-]{5,}\d/g) || [];
  return [...new Set(matches.map((phone) => phone.trim()).filter(Boolean))];
}

function contactPickerAvailable() {
  return Boolean(navigator.contacts?.select);
}

function contactLookupText(user) {
  return cleanDisplayText(user.contact || user.matchedContact, "");
}

function userSearchText(user) {
  return [
    user.displayName,
    user.previewName,
    user.username,
    user.contact,
    user.matchedContact,
    String(user.contact || "").replace(/\D/g, ""),
    String(user.matchedContact || "").replace(/\D/g, "")
  ].join(" ").toLowerCase();
}

function renderUserAvatar(user, className = "panel-row-avatar") {
  const initial = String(user?.displayName || user?.username || "Я").trim().slice(0, 1).toUpperCase() || "Я";
  const content = user?.avatarDataUrl
    ? `<img src="${escapeHtml(user.avatarDataUrl)}" alt="" />`
    : escapeHtml(initial);
  return `<span class="${className}">${content}</span>`;
}

function uniqueContactPhones(items) {
  const seen = new Set();
  const phones = [];

  (Array.isArray(items) ? items : []).forEach((item) => {
    const phone = typeof item === "object" ? item?.phone || item?.tel || item?.contact : item;
    const source = String(phone || "").trim();
    const primaryKey = [...contactMatchKeys(source)][0];

    if (!source || !primaryKey || seen.has(primaryKey)) {
      return;
    }

    seen.add(primaryKey);
    phones.push(source);
  });

  return phones;
}

async function requestDeviceContacts() {
  if (!contactPickerAvailable()) {
    throw new Error(t("contactsUnavailable"));
  }

  const records = await navigator.contacts.select(["name", "tel"], { multiple: true });
  return (records || []).flatMap((record) => {
    const name = Array.isArray(record.name) ? record.name[0] : record.name;
    const phones = Array.isArray(record.tel) ? record.tel : [];
    return phones.map((phone) => ({ name: String(name || "").trim(), phone }));
  });
}

async function matchContactsFromUsers(phones) {
  const requested = new Set(uniqueContactPhones(phones).flatMap((phone) => [...contactMatchKeys(phone)]));

  if (requested.size === 0) {
    return [];
  }

  const users = await yachatApi.users.list();
  return (users || []).filter((user) => {
    if (!user || user.id === state.account?.id) {
      return false;
    }

    return [...contactMatchKeys(user.contact)].some((key) => requested.has(key));
  });
}

async function lookupContacts(phones, sourceButton = null) {
  const contacts = uniqueContactPhones(phones);

  if (contacts.length === 0) {
    state.contactLookupMessage = t("contactsInputEmpty");
    renderPanel();
    return [];
  }

  state.contactLookupLoading = true;
  state.contactLookupMessage = "";
  renderPanel();

  if (sourceButton) {
    setLoading(sourceButton, true);
  }

  try {
    const users = yachatApi.contacts?.lookup
      ? await yachatApi.contacts.lookup({ contacts })
      : await matchContactsFromUsers(contacts);
    const normalized = (users || [])
      .map(normalizeUser)
      .filter((user) => user && user.id !== state.account?.id);
    const byId = new Map(normalized.map((user) => [user.id, user]));

    state.contactMatches = [...byId.values()];
    state.contactLookupMessage = state.contactMatches.length
      ? t("contactsFoundCount", { count: state.contactMatches.length })
      : t("contactsNoMatches");
    return state.contactMatches;
  } catch (error) {
    state.contactLookupMessage = error.message || t("contactsUnavailable");
    return [];
  } finally {
    state.contactLookupLoading = false;
    if (sourceButton) {
      setLoading(sourceButton, false);
    }
    renderPanel();
  }
}

async function importDeviceContacts(sourceButton) {
  try {
    const contacts = await requestDeviceContacts();
    await lookupContacts(contacts, sourceButton);
  } catch (error) {
    state.contactLookupMessage = error.name === "NotAllowedError"
      ? t("contactsPermissionDenied")
      : error.message || t("contactsUnavailable");
    state.contactLookupLoading = false;
    renderPanel();
  }
}

async function checkManualContacts(sourceButton) {
  const text = panelBody?.querySelector("[data-contact-input]")?.value || "";
  await lookupContacts(extractContactPhones(text), sourceButton);
}

function contactProfilePayload(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    previewName: user.previewName || user.displayName,
    contact: contactLookupText(user),
    avatarDataUrl: user.avatarDataUrl || "",
    avatarAccent: user.avatarAccent || "#471AFF"
  };
}

function renderContactMatches() {
  if (state.contactMatches.length === 0) {
    return `<p class="empty-users">${t("contactsNoMatches")}</p>`;
  }

  return state.contactMatches.map((user) => {
    const contact = contactLookupText(user);
    return `
      <button class="panel-row contact-row" type="button" data-contact-user-id="${escapeHtml(user.id)}">
        ${renderUserAvatar(user)}
        <span>
          <strong>${escapeHtml(user.displayName)}</strong>
          <small>@${escapeHtml(user.username)}${contact ? ` · ${escapeHtml(contact)}` : ""}</small>
        </span>
        <b>${escapeHtml(t("openChat"))}</b>
      </button>
    `;
  }).join("");
}

function renderChatSearchUsers() {
  if (state.chatSearchLoading) {
    return `<p class="empty-users">${escapeHtml(t("search"))}...</p>`;
  }

  if (state.chatSearchError) {
    return `<p class="empty-users">${escapeHtml(state.chatSearchError)}</p>`;
  }

  if (state.chatSearchUsers.length === 0) {
    return `<p class="empty-users">${t("noPeopleFound")}</p>`;
  }

  return state.chatSearchUsers.map((user) => {
    const chat = createPendingSearchChat(user);
    const contact = contactLookupText(user);
    return `
      <button class="chat-row${chat.id === state.activeChatId ? " is-active" : ""}" type="button" data-search-user-id="${escapeHtml(user.id)}">
        ${renderChatAvatar(chat)}
        <span class="chat-row-main">
          <span class="chat-row-top">
            <strong>${escapeHtml(user.displayName)}</strong>
            <time>${escapeHtml(t("openChat"))}</time>
          </span>
          <span class="chat-row-bottom">
            <span>@${escapeHtml(user.username)}${contact ? ` · ${escapeHtml(contact)}` : ""}</span>
          </span>
        </span>
      </button>
    `;
  }).join("");
}

async function openPendingPrivateChat(user, options = {}) {
  const normalized = normalizeUser(user);

  if (!normalized?.id) {
    throw new Error(t("errChoosePerson"));
  }

  const existing = findPrivateChatForUser(normalized.id);
  if (existing) {
    state.pendingSearchChat = null;
    if (options.closePanelOnOpen) {
      closePanel();
    }
    await selectChat(existing.id);
    return;
  }

  closeMessageMenu();
  closeForwardPicker();
  state.pendingSearchChat = createPendingSearchChat(normalized);
  state.activeChatId = state.pendingSearchChat.id;
  state.messages = [];
  state.editingMessageId = null;
  state.replyToMessage = null;
  state.selectedMessageIds.clear();
  state.selectingMessages = false;

  if (options.closePanelOnOpen) {
    closePanel();
  }

  renderComposerContext();
  setMobileDialogOpen(true);
  renderChatList();
  renderActiveChat();
  renderMessages();
}

async function openPrivateChatWithContact(userId, sourceButton = null) {
  const user = state.contactMatches.find((item) => item.id === userId);

  if (sourceButton) {
    setLoading(sourceButton, true);
  }

  try {
    await openPendingPrivateChat(user, { closePanelOnOpen: true });
  } catch (error) {
    state.contactLookupMessage = error.message || t("errSendMessage");
    renderPanel();
  } finally {
    if (sourceButton) {
      setLoading(sourceButton, false);
    }
  }
}

async function openPrivateChatFromSearch(userId) {
  const user = state.chatSearchUsers.find((item) => item.id === userId);
  await openPendingPrivateChat(user);
}

async function ensureRealChatForMessage(chat) {
  if (!chat?.pendingSearchUserId) {
    return chat;
  }

  const user = chat.pendingSearchUser || chat.participantProfiles?.[chat.pendingSearchUserId];
  const participantProfiles = user ? { [chat.pendingSearchUserId]: contactProfilePayload(user) } : {};
  const result = await yachatApi.messenger.createChat({
    kind: "private",
    participantIds: [chat.pendingSearchUserId],
    participantProfiles,
    title: user?.displayName || chat.title || ""
  });

  state.chats = result.chats || await yachatApi.messenger.chats();
  state.activeChatId = result.chat?.id || state.activeChatId;
  state.messages = result.messages || await yachatApi.messenger.messages(state.activeChatId);
  state.pendingSearchChat = null;

  return getActiveChat();
}

function utf8Bytes(value) {
  return [...new TextEncoder().encode(String(value || ""))];
}

function pushBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) {
    bits.push((value >>> i) & 1);
  }
}

function createQrGaloisTables() {
  const exp = new Array(512).fill(0);
  const log = new Array(256).fill(0);
  let value = 1;

  for (let i = 0; i < 255; i += 1) {
    exp[i] = value;
    log[value] = i;
    value <<= 1;
    if (value & 0x100) {
      value ^= 0x11d;
    }
  }

  for (let i = 255; i < 512; i += 1) {
    exp[i] = exp[i - 255];
  }

  return { exp, log };
}

function qrMultiply(a, b, tables) {
  if (a === 0 || b === 0) {
    return 0;
  }
  return tables.exp[tables.log[a] + tables.log[b]];
}

function createQrGeneratorPolynomial(degree, tables) {
  let polynomial = [1];

  for (let i = 0; i < degree; i += 1) {
    const next = new Array(polynomial.length + 1).fill(0);
    polynomial.forEach((coefficient, index) => {
      next[index] ^= coefficient;
      next[index + 1] ^= qrMultiply(coefficient, tables.exp[i], tables);
    });
    polynomial = next;
  }

  return polynomial;
}

function createQrErrorCorrection(data, eccLength) {
  const tables = createQrGaloisTables();
  const generator = createQrGeneratorPolynomial(eccLength, tables);
  const result = new Array(eccLength).fill(0);

  data.forEach((byte) => {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < eccLength; i += 1) {
      result[i] ^= qrMultiply(generator[i + 1], factor, tables);
    }
  });

  return result;
}

function createQrFormatBits(mask) {
  const errorLevelBits = 1; // L
  let data = (errorLevelBits << 3) | mask;
  let bits = data << 10;
  const generator = 0x537;

  for (let i = 14; i >= 10; i -= 1) {
    if ((bits >>> i) & 1) {
      bits ^= generator << (i - 10);
    }
  }

  return (((data << 10) | bits) ^ 0x5412) & 0x7fff;
}

function createQrMatrix(payload) {
  const version = 4;
  const size = 33;
  const dataCodewords = 80;
  const eccCodewords = 20;
  const bytes = utf8Bytes(payload);

  if (bytes.length > 72) {
    throw new Error("QR token is too long.");
  }

  const bits = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, 8);
  bytes.forEach((byte) => pushBits(bits, byte, 8));
  const maxBits = dataCodewords * 8;
  pushBits(bits, 0, Math.min(4, maxBits - bits.length));
  while (bits.length % 8) {
    bits.push(0);
  }

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }

  for (let pad = 0; data.length < dataCodewords; pad += 1) {
    data.push(pad % 2 === 0 ? 0xec : 0x11);
  }

  const codewords = [...data, ...createQrErrorCorrection(data, eccCodewords)];
  const matrix = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  function setFunction(x, y, dark) {
    if (x < 0 || y < 0 || x >= size || y >= size) {
      return;
    }
    matrix[y][x] = Boolean(dark);
    reserved[y][x] = true;
  }

  function drawFinder(x, y) {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const xx = x + dx;
        const yy = y + dy;
        const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        const dark = inside && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        setFunction(xx, yy, dark);
      }
    }
  }

  function drawAlignment(cx, cy) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
        setFunction(cx + dx, cy + dy, dark);
      }
    }
  }

  drawFinder(0, 0);
  drawFinder(size - 7, 0);
  drawFinder(0, size - 7);
  drawAlignment(26, 26);

  for (let i = 8; i < size - 8; i += 1) {
    setFunction(i, 6, i % 2 === 0);
    setFunction(6, i, i % 2 === 0);
  }

  setFunction(8, 4 * version + 9, true);

  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }

  const dataBits = codewords.flatMap((byte) => {
    const out = [];
    pushBits(out, byte, 8);
    return out;
  });
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right -= 1;
    }

    for (let vertical = 0; vertical < size; vertical += 1) {
      const y = upward ? size - 1 - vertical : vertical;
      for (let dx = 0; dx < 2; dx += 1) {
        const x = right - dx;
        if (reserved[y][x]) {
          continue;
        }
        const bit = bitIndex < dataBits.length ? dataBits[bitIndex] : 0;
        const mask = (x + y) % 2 === 0;
        matrix[y][x] = Boolean(bit) !== mask;
        bitIndex += 1;
      }
    }

    upward = !upward;
  }

  const format = createQrFormatBits(0);
  function formatBit(index) {
    return ((format >>> index) & 1) === 1;
  }

  for (let i = 0; i <= 5; i += 1) setFunction(8, i, formatBit(i));
  setFunction(8, 7, formatBit(6));
  setFunction(8, 8, formatBit(7));
  setFunction(7, 8, formatBit(8));
  for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, formatBit(i));
  for (let i = 0; i < 8; i += 1) setFunction(size - 1 - i, 8, formatBit(i));
  for (let i = 8; i < 15; i += 1) setFunction(8, size - 15 + i, formatBit(i));

  return matrix;
}

function renderQrSvg(payload) {
  const matrix = createQrMatrix(payload);
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  const rects = [];

  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) {
        rects.push(`<rect x="${x + quiet}" y="${y + quiet}" width="1" height="1" rx="0.18" ry="0.18" />`);
      }
    });
  });

  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="QR">${rects.join("")}</svg>`;
}

function accountAvatarHtml(sizeClass = "panel-avatar") {
  const account = state.account || {};
  const initial = String(cleanDisplayText(account.displayName, account.username || "Я")).trim().slice(0, 1).toUpperCase() || "Я";

  if (account.avatarDataUrl) {
    return `<div class="${sizeClass}"><img src="${escapeHtml(account.avatarDataUrl)}" alt="" /></div>`;
  }

  return `<div class="${sizeClass}">${escapeHtml(initial)}</div>`;
}

function profileEditAvatarData(account = state.account || {}) {
  return state.profileEditAvatarDataUrl === null
    ? cleanDisplayText(account.avatarDataUrl, "")
    : cleanDisplayText(state.profileEditAvatarDataUrl, "");
}

function profileEditAvatarHtml(account = state.account || {}) {
  const dataUrl = profileEditAvatarData(account);
  const initial = String(cleanDisplayText(account.displayName, account.username || "Я")).trim().slice(0, 1).toUpperCase() || "Я";
  return dataUrl
    ? `<button class="profile-edit-avatar-preview" type="button" data-panel-action="pick-profile-avatar"><img src="${escapeHtml(dataUrl)}" alt="" /></button>`
    : `<button class="profile-edit-avatar-preview" type="button" data-panel-action="pick-profile-avatar">${escapeHtml(initial)}</button>`;
}

function renderProfileEditor(account = state.account || {}) {
  if (!state.editingProfile) {
    return "";
  }

  const username = normalizeUsername(account.username) || "user";
  const avatarDataUrl = profileEditAvatarData(account);

  return `
    <section class="panel-section profile-edit-section">
      <h3>${t("editProfile")}</h3>
      <div class="profile-edit-avatar">
        ${profileEditAvatarHtml(account)}
        <div class="panel-actions">
          <button type="button" data-panel-action="pick-profile-avatar">${iconSvg("image")}<span>${t("changeAvatar")}</span></button>
          <button type="button" data-panel-action="remove-profile-avatar" ${avatarDataUrl ? "" : "disabled"}>${iconSvg("x")}<span>${t("removeAvatar")}</span></button>
        </div>
        <input class="visually-hidden" type="file" accept="image/*" data-profile-avatar-input />
      </div>
      <label class="panel-field">
        <span>${t("name")}</span>
        <input type="text" maxlength="60" value="${escapeHtml(cleanDisplayText(account.displayName, ""))}" data-profile-display-name />
      </label>
      <label class="panel-field">
        <span>${t("username")}</span>
        <div class="username-input-shell is-panel">
          <b aria-hidden="true">@</b>
          <input type="text" maxlength="24" autocomplete="username" value="${escapeHtml(username)}" data-profile-username />
        </div>
      </label>
      <label class="panel-field">
        <span>${t("bio")}</span>
        <textarea rows="3" maxlength="140" placeholder="${escapeHtml(t("bioPlaceholder"))}" data-profile-bio>${escapeHtml(cleanDisplayText(account.bio, ""))}</textarea>
      </label>
      <div class="session-message" data-profile-edit-message>${escapeHtml(state.profileEditMessage || "")}</div>
      <div class="panel-actions">
        <button class="panel-primary" type="button" data-panel-action="save-profile">${iconSvg("check", "button-icon")}<span>${t("saveChat")}</span></button>
        <button type="button" data-panel-action="cancel-profile-edit">${iconSvg("x")}<span>${t("cancel")}</span></button>
      </div>
    </section>
  `;
}

function openProfileEditor() {
  state.editingProfile = true;
  state.profileEditAvatarDataUrl = null;
  state.profileEditMessage = "";
  renderPanel();
}

function closeProfileEditor() {
  state.editingProfile = false;
  state.profileEditAvatarDataUrl = null;
  state.profileEditMessage = "";
  renderPanel();
}

function setProfileEditMessage(text) {
  state.profileEditMessage = text || "";
  const target = panelBody?.querySelector("[data-profile-edit-message]");
  if (target) {
    target.textContent = state.profileEditMessage;
  }
}

function closePanel() {
  state.activePanel = null;
  state.pendingChatAvatarDataUrl = null;
  state.editingProfile = false;
  state.profileEditAvatarDataUrl = null;
  state.profileEditMessage = "";
  stopQrScanner();
  if (sidePanel) {
    sidePanel.hidden = true;
  }
}

function stopQrScanner() {
  window.clearTimeout(state.qrScannerTimer);
  state.qrScannerTimer = null;

  if (state.qrScannerStream) {
    state.qrScannerStream.getTracks().forEach((track) => track.stop());
    state.qrScannerStream = null;
  }

  const video = panelBody?.querySelector("[data-session-camera]");
  const message = panelBody?.querySelector("[data-session-message]");
  if (video) {
    video.pause();
    video.srcObject = null;
    video.hidden = true;
  }
  if (message) {
    message.textContent = "";
  }
}

function shouldUseSessionCaptureFallback() {
  return !navigator.mediaDevices?.getUserMedia || (!window.isSecureContext && location.protocol !== "file:");
}

function openSessionCaptureFallback() {
  const input = panelBody?.querySelector("[data-session-capture]");
  const message = panelBody?.querySelector("[data-session-message]");

  stopQrScanner();

  if (message) {
    message.textContent = t("cameraCaptureHint");
  }

  if (!input) {
    alert(t("cameraQrUnavailable"));
    return false;
  }

  input.value = "";
  input.click();
  return true;
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t("cameraCaptureNoQr")));
    };
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.src = url;
  });
}

async function detectQrFromImageFile(file) {
  if (!file || (file.type && !file.type.startsWith("image/"))) {
    throw new Error(t("cameraCaptureNoQr"));
  }

  if (!("BarcodeDetector" in window)) {
    throw new Error(t("cameraCaptureNoDetector"));
  }

  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  let codes = [];

  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(file);
    try {
      codes = await detector.detect(bitmap);
    } finally {
      bitmap.close?.();
    }
  } else {
    const image = await loadImageFromFile(file);
    codes = await detector.detect(image);
  }

  const value = codes[0]?.rawValue || "";
  if (!value) {
    throw new Error(t("cameraCaptureNoQr"));
  }

  return value;
}

async function scanCapturedSessionImage(file) {
  const message = panelBody?.querySelector("[data-session-message]");

  if (!file) {
    return;
  }

  if (message) {
    message.textContent = t("cameraCaptureScanning");
  }

  try {
    const payload = await detectQrFromImageFile(file);
    if (message) {
      message.textContent = "";
    }
    await confirmQrPayload(payload);
  } catch (error) {
    if (message) {
      message.textContent = error.message || t("cameraQrUnavailable");
    } else {
      alert(error.message || t("cameraQrUnavailable"));
    }
  }
}

async function startQrScanner() {
  const video = panelBody?.querySelector("[data-session-camera]");
  const message = panelBody?.querySelector("[data-session-message]");

  if (shouldUseSessionCaptureFallback()) {
    openSessionCaptureFallback();
    return;
  }

  if (!video) {
    return;
  }

  stopQrScanner();

  try {
    state.qrScannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });
    video.srcObject = state.qrScannerStream;
    video.hidden = false;
    await video.play();

    if (!("BarcodeDetector" in window)) {
      if (message) {
        message.textContent = "Камера открыта. Автосканер QR в этой среде недоступен.";
      }
      return;
    }

    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    if (message) {
      message.textContent = "Камера открыта. Наведите её на QR-код ЯЧата.";
    }

    const scan = async () => {
      try {
        const codes = await detector.detect(video);
        const value = codes[0]?.rawValue || "";
        if (value) {
          stopQrScanner();
          if (message) {
            message.textContent = "";
          }
          await confirmQrPayload(value);
          return;
        }
      } catch {
        // Try next frame.
      }
      state.qrScannerTimer = window.setTimeout(scan, 500);
    };

    scan();
  } catch (error) {
    stopQrScanner();
    if (!openSessionCaptureFallback()) {
      alert(error.message || t("cameraQrUnavailable"));
    }
  }
}

async function confirmQrPayload(payload) {
  try {
    await yachatApi.qr.confirm({ payload });
    alert(t("qrApproved"));
  } catch (error) {
    alert(error.message || t("errVerify"));
  }
}

function renderPanel() {
  if (!sidePanel || !panelBody || !panelTitle || !panelKicker) {
    return;
  }

  const account = state.account || {};
  const title = state.activePanel === "contacts"
    ? t("contacts")
    : state.activePanel === "calls"
      ? t("calls")
      : state.activePanel === "chat"
        ? t("chatInfo")
        : t("profileAndSettings");

  panelTitle.textContent = title;
  panelKicker.textContent = "";
  panelKicker.hidden = true;

  if (state.activePanel === "chat") {
    const chat = getActiveChat();
    const canEdit = canEditActiveChat(chat);
    const ownsGroup = canOwnActiveGroup(chat);
    const privateProfileManaged = chat?.kind === "private";
    const invite = chat?.inviteUrl || chat?.inviteCode || "";
    const displayChat = chat
      ? {
          ...chat,
          avatarDataUrl: state.pendingChatAvatarDataUrl === null ? chat.avatarDataUrl : state.pendingChatAvatarDataUrl
        }
      : null;

    if (!chat) {
      panelBody.innerHTML = "";
      return;
    }

    const editSection = canEdit ? `
      <section class="panel-section">
        <h3>${t("chatInfo")}</h3>
        <label class="panel-field">
          <span>${t("chatTitle")}</span>
          <input type="text" value="${escapeHtml(getChatTitle(chat))}" maxlength="60" data-chat-title />
        </label>
        <label class="panel-field">
          <span>${t("chatDescription")}</span>
          <textarea rows="3" maxlength="180" placeholder="${escapeHtml(t("chatDescriptionPlaceholder"))}" data-chat-description>${escapeHtml(cleanDisplayText(chat.description, ""))}</textarea>
        </label>
        <input class="visually-hidden" type="file" accept="image/*" data-chat-avatar-input />
        <div class="panel-actions">
          <button type="button" data-panel-action="pick-chat-avatar">${iconSvg("image")}<span>${t("changeAvatar")}</span></button>
          <button type="button" data-panel-action="remove-chat-avatar" ${displayChat.avatarDataUrl ? "" : "disabled"}>${iconSvg("x")}<span>${t("removeAvatar")}</span></button>
        </div>
        <button class="panel-primary" type="button" data-panel-action="save-chat">${iconSvg("check", "button-icon")}<span>${t("saveChat")}</span></button>
      </section>
    ` : "";

    panelBody.innerHTML = `
      <section class="profile-card chat-profile-card">
        ${renderChatAvatar(displayChat, "panel-avatar")}
        <div>
          <h3>${escapeHtml(getChatTitle(chat))} ${renderVerified(chat)}</h3>
          <p>${escapeHtml(getChatSubtitle(chat))}</p>
          <small>${chat.locked ? t("cannotLeave") : privateProfileManaged ? t("privateManagedByProfiles") : ownsGroup ? t("groupOwner") : t("ownerOnly")}</small>
        </div>
      </section>
      ${editSection}
      ${chat.kind === "group" ? `
        <section class="panel-section">
          <h3>${t("invitePeople")}</h3>
          <p>${ownsGroup ? t("groupOwner") : t("ownerOnly")}</p>
          ${invite ? `<div class="invite-box"><span>${t("inviteCode")}</span><strong>${escapeHtml(invite)}</strong></div>` : ""}
          <button class="panel-primary is-secondary" type="button" data-panel-action="invite-chat" ${ownsGroup ? "" : "disabled"}>${iconSvg("users", "button-icon")}<span>${t("invitePeople")}</span></button>
          ${invite ? `<button class="panel-primary is-secondary" type="button" data-panel-action="copy-invite">${iconSvg("copy", "button-icon")}<span>${t("copyInvite")}</span></button>` : ""}
        </section>
      ` : ""}
      <section class="panel-section">
        <h3>${t("leaveChat")}</h3>
        <p>${chat.locked ? t("cannotLeave") : getChatTitle(chat)}</p>
        <button class="panel-primary is-danger" type="button" data-panel-action="leave-chat" ${chat.locked ? "disabled" : ""}>${iconSvg("log-out", "button-icon")}<span>${t("leaveChat")}</span></button>
      </section>
    `;
    hydrateIcons(panelBody);
    return;
  }

  if (state.activePanel === "contacts") {
    panelBody.innerHTML = `
      <section class="panel-section">
        <h3>${t("contactsImportTitle")}</h3>
        <p>${t("contactsImportHint")}</p>
        <div class="panel-actions">
          <button class="panel-primary is-secondary" type="button" data-panel-action="request-contacts" ${state.contactLookupLoading ? "disabled" : ""}>${iconSvg("users", "button-icon")}<span>${t("requestContacts")}</span></button>
          <button type="button" data-panel-action="check-contact-input" ${state.contactLookupLoading ? "disabled" : ""}>${iconSvg("search", "button-icon")}<span>${t("checkContacts")}</span></button>
        </div>
        <textarea class="session-input contacts-input" rows="4" placeholder="${escapeHtml(t("contactsInputPlaceholder"))}" data-contact-input></textarea>
        <div class="session-message" data-contact-status>${escapeHtml(state.contactLookupMessage || "")}</div>
      </section>
      <section class="panel-section">
        <h3>${t("contactsFoundTitle")}</h3>
        ${renderContactMatches()}
      </section>
    `;
    hydrateIcons(panelBody);
    return;
  }

  if (state.activePanel === "calls") {
    panelBody.innerHTML = `
      <section class="panel-section">
        <h3>${t("calls")}</h3>
        <p>${t("callsEmpty")}</p>
      </section>
    `;
    return;
  }

  panelBody.innerHTML = `
    <button class="profile-card profile-edit-trigger" type="button" data-panel-action="edit-profile">
      ${accountAvatarHtml()}
      <div>
        <h3>${escapeHtml(cleanDisplayText(account.displayName, account.username || "ЯЧат"))}</h3>
        <p>@${escapeHtml(cleanDisplayText(account.username, "user"))}</p>
        <small>${escapeHtml(cleanDisplayText(account.bio, t("profileEditHint")))}</small>
      </div>
    </button>
    ${renderProfileEditor(account)}
    <section class="panel-section">
      <h3>${t("settings")}</h3>
      <div class="panel-actions">
        <button type="button" data-panel-action="toggle-theme">${iconSvg(themeIconName())}<span>${t("themeAria")}</span></button>
      </div>
    </section>
    <section class="panel-section">
      <h3>Информация</h3>
      <p>Политика конфиденциальности и условия использования.</p>
      <div class="panel-actions">
        <button type="button" data-panel-action="open-policy">${iconSvg("shield-check")}<span>Политика</span></button>
        <button type="button" data-panel-action="open-terms">${iconSvg("file-text")}<span>Условия</span></button>
      </div>
    </section>
    <section class="panel-section">
      <h3>${t("sessions")}</h3>
      <p>${t("sessionsHint")}</p>
      <video class="session-camera" data-session-camera hidden muted playsinline></video>
      <input class="visually-hidden" type="file" accept="image/*" capture="environment" data-session-capture />
      <p class="session-message" data-session-message></p>
      <button class="panel-primary is-secondary" type="button" data-panel-action="scan-session">${iconSvg("scan-line", "button-icon")}<span>${t("openCamera")}</span></button>
      <button class="panel-primary is-danger" type="button" data-panel-action="logout">${iconSvg("log-out", "button-icon")}<span>${t("logout")}</span></button>
    </section>
    <section class="panel-section">
      <h3>${t("dangerZone")}</h3>
      <p>${t("deleteProfileHint")}</p>
      <button class="panel-primary is-danger" type="button" data-panel-action="delete-profile">${iconSvg("trash", "button-icon")}<span>${t("deleteProfile")}</span></button>
    </section>
  `;
  hydrateIcons(panelBody);
}

function openPanel(type) {
  state.activePanel = type || "settings";
  state.pendingChatAvatarDataUrl = null;
  state.editingProfile = false;
  state.profileEditAvatarDataUrl = null;
  state.profileEditMessage = "";
  if (sidePanel) {
    sidePanel.hidden = false;
  }
  renderPanel();
}

function openCreateChat() {
  if (!createChatModal || !createChatForm) {
    return;
  }

  state.newChatKind = "private";
  state.createChatSelectedIds = [];
  state.pendingCreateChatAvatarDataUrl = "";
  createChatModal.hidden = false;
  createChatForm.reset();
  setMessage("create-chat", "");
  loadCreateChatUsers().finally(() => {
    renderCreateChatForm();
    requestAnimationFrame(() => createChatForm.elements.peopleSearch?.focus());
  });
}

function closeCreateChat() {
  if (createChatModal) {
    createChatModal.hidden = true;
  }
  state.createChatSelectedIds = [];
  state.pendingCreateChatAvatarDataUrl = "";
}

async function loadCreateChatUsers() {
  try {
    const users = await yachatApi.users.list();
    state.createChatUsers = (users || [])
      .map(normalizeUser)
      .filter((user) => user && user.id !== state.account?.id);
  } catch {
    state.createChatUsers = [];
  }
}

function normalizeChatSearchUsers(users) {
  const seen = new Set();
  return (users || [])
    .map(normalizeUser)
    .filter((user) => {
      if (!user?.id || user.id === state.account?.id || seen.has(user.id) || findPrivateChatForUser(user.id)) {
        return false;
      }

      seen.add(user.id);
      return true;
    })
    .slice(0, 8);
}

async function searchChatUserDirectory(query, requestId) {
  state.chatSearchLoading = true;
  state.chatSearchError = "";
  state.chatSearchUsers = [];
  renderChatList();

  try {
    const users = yachatApi.users?.search
      ? await yachatApi.users.search(query)
      : await yachatApi.users.list();

    if (requestId !== state.chatSearchRequestId || query !== chatSearchValue()) {
      return;
    }

    state.chatSearchUsers = normalizeChatSearchUsers(users);
  } catch (error) {
    if (requestId !== state.chatSearchRequestId) {
      return;
    }

    state.chatSearchUsers = [];
    state.chatSearchError = error.message || t("contactsUnavailable");
  } finally {
    if (requestId === state.chatSearchRequestId) {
      state.chatSearchLoading = false;
      renderChatList();
    }
  }
}

function refreshChatSearch() {
  const query = chatSearchValue();
  const chats = getChatSearchMatches(query.toLowerCase());
  const requestId = state.chatSearchRequestId + 1;

  state.chatSearchRequestId = requestId;
  state.chatSearchError = "";

  if (!shouldSearchUserDirectory(query, chats)) {
    state.chatSearchLoading = false;
    state.chatSearchUsers = [];
    renderChatList();
    return;
  }

  searchChatUserDirectory(query, requestId);
}

function getCreateChatSelectedUsers() {
  const selected = new Set(state.createChatSelectedIds);
  return state.createChatUsers.filter((user) => selected.has(user.id));
}

function updateCreateChatAvatarPreview() {
  const image = createChatForm?.querySelector("[data-create-chat-avatar-image]");
  const initial = createChatForm?.querySelector("[data-create-chat-avatar-initial]");
  const source = state.pendingCreateChatAvatarDataUrl;
  const title = createChatForm?.elements.title?.value || t("groupChat");
  const letter = String(title).trim().slice(0, 1).toUpperCase() || "Я";

  if (image) {
    image.hidden = !source;
    if (source) {
      image.src = source;
    } else {
      image.removeAttribute("src");
    }
  }

  if (initial) {
    initial.hidden = Boolean(source);
    initial.textContent = letter;
  }
}

function renderCreateChatForm() {
  if (!createChatForm) {
    return;
  }

  const isGroup = state.newChatKind === "group";
  const selectedUsers = getCreateChatSelectedUsers();
  const searchInput = createChatForm.elements.peopleSearch;
  const query = String(searchInput?.value || "").trim().toLowerCase();
  const resultsTarget = createChatForm.querySelector("[data-create-user-results]");
  const selectedTarget = createChatForm.querySelector("[data-create-selected-users]");
  const submit = createChatForm.querySelector(".main-button");
  const titleInput = createChatForm.elements.title;
  const titleLabel = createChatForm.querySelector("[data-create-title-label]");
  const peopleLabel = createChatForm.querySelector("[data-create-people-label]");
  const descriptionLabel = createChatForm.querySelector("[data-create-description-label]");
  const avatarTitle = createChatForm.querySelector("[data-create-avatar-title]");
  const avatarAction = createChatForm.querySelector("[data-create-avatar-action]");

  createChatForm.querySelectorAll("[data-chat-kind]").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.chatKind === state.newChatKind);
  });

  createChatForm.querySelectorAll("[data-create-group-field]").forEach((field) => {
    field.hidden = !isGroup;
  });

  if (titleInput) {
    titleInput.required = isGroup;
    titleInput.placeholder = t("groupChatName");
  }

  if (titleLabel) {
    titleLabel.textContent = t("groupChatName");
  }

  if (peopleLabel) {
    peopleLabel.textContent = isGroup ? t("addPeople") : t("privateChatTarget");
  }

  if (descriptionLabel) {
    descriptionLabel.textContent = t("groupChatDescription");
  }

  if (avatarTitle) {
    avatarTitle.textContent = t("groupAvatar");
  }

  if (avatarAction) {
    avatarAction.textContent = t("chooseGroupAvatar");
  }

  if (searchInput) {
    searchInput.placeholder = t("peopleSearchPlaceholder");
  }

  const selected = new Set(state.createChatSelectedIds);
  const candidates = state.createChatUsers
    .filter((user) => !selected.has(user.id))
    .filter((user) => !query || userSearchText(user).includes(query))
    .slice(0, 8);

  if (resultsTarget) {
    resultsTarget.innerHTML = candidates.length
      ? candidates.map((user) => `
          <button class="user-choice-row" type="button" data-create-user-id="${escapeHtml(user.id)}">
            ${renderUserAvatar(user)}
            <span>
              <strong>${escapeHtml(user.displayName)}</strong>
              <small>@${escapeHtml(user.username)}${user.contact ? ` · ${escapeHtml(user.contact)}` : ""}</small>
            </span>
          </button>
        `).join("")
      : `<p class="empty-users">${t("noPeopleFound")}</p>`;
  }

  if (selectedTarget) {
    selectedTarget.hidden = selectedUsers.length === 0;
    selectedTarget.innerHTML = selectedUsers.map((user) => `
      <button class="selected-user-chip" type="button" data-remove-create-user="${escapeHtml(user.id)}">
        <span>${escapeHtml(user.displayName)}</span>
        ${iconSvg("x")}
      </button>
    `).join("");
  }

  if (submit) {
    submit.disabled = isGroup
      ? selectedUsers.length < 1 || !String(titleInput?.value || "").trim()
      : selectedUsers.length !== 1;
  }

  updateCreateChatAvatarPreview();
}

async function createChatFromForm(submitButton) {
  const isGroup = state.newChatKind === "group";
  const title = String(createChatForm.elements.title?.value || "").trim();
  const participantIds = [...state.createChatSelectedIds];

  if (!isGroup && participantIds.length !== 1) {
    setMessage("create-chat", t("errChoosePerson"));
    return;
  }

  if (isGroup && participantIds.length < 1) {
    setMessage("create-chat", t("errChooseGroupMember"));
    return;
  }

  if (isGroup && !title) {
    setMessage("create-chat", t("errGroupName"));
    return;
  }

  setLoading(submitButton, true);
  setMessage("create-chat", "");

  try {
    const result = await yachatApi.messenger.createChat({
      kind: state.newChatKind,
      participantIds,
      title: isGroup ? title : "",
      description: isGroup ? String(createChatForm.elements.description?.value || "").trim() : "",
      avatarDataUrl: isGroup ? state.pendingCreateChatAvatarDataUrl : ""
    });
    state.chats = result.chats || await yachatApi.messenger.chats();
    state.activeChatId = result.chat?.id || state.activeChatId;
    state.messages = result.messages || await yachatApi.messenger.messages(state.activeChatId);
    closeCreateChat();
    renderChatList();
    renderActiveChat();
    renderMessages();
    setMobileDialogOpen(true);
  } catch (error) {
    setMessage("create-chat", error.message || t("errSendMessage"));
  } finally {
    setLoading(submitButton, false);
    renderCreateChatForm();
  }
}

async function saveActiveChat(submitButton) {
  const chat = getActiveChat();
  if (!chat || !yachatApi.messenger?.updateChat) {
    return;
  }

  const title = panelBody?.querySelector("[data-chat-title]")?.value || getChatTitle(chat);
  const description = panelBody?.querySelector("[data-chat-description]")?.value || "";
  const avatarDataUrl = state.pendingChatAvatarDataUrl === null ? chat.avatarDataUrl || "" : state.pendingChatAvatarDataUrl;

  setLoading(submitButton, true);

  try {
    const result = await yachatApi.messenger.updateChat({
      chatId: chat.id,
      title,
      description,
      avatarDataUrl
    });
    state.pendingChatAvatarDataUrl = null;
    state.chats = result.chats || await yachatApi.messenger.chats();
    state.messages = result.messages || state.messages;
    renderChatList();
    renderActiveChat();
    renderPanel();
  } catch (error) {
    alert(translatedServerMessage(error.message, "errSendMessage"));
  } finally {
    setLoading(submitButton, false);
  }
}

async function saveProfileFromPanel(submitButton) {
  if (!state.account || !yachatApi.account?.update) {
    return;
  }

  const displayName = String(panelBody?.querySelector("[data-profile-display-name]")?.value || "").trim();
  const usernameInput = panelBody?.querySelector("[data-profile-username]");
  const username = normalizeUsernameInput(usernameInput);
  const bio = String(panelBody?.querySelector("[data-profile-bio]")?.value || "").trim();
  const avatarDataUrl = profileEditAvatarData(state.account);

  if (!displayName) {
    setProfileEditMessage(t("errName"));
    return;
  }

  if (!username || username.length < 3) {
    setProfileEditMessage(t("errUsername"));
    return;
  }

  setLoading(submitButton, true);
  setProfileEditMessage(t("usernameChecking"));

  try {
    const usernameStatus = await ensureUsernameAvailable(username);
    if (!usernameStatus.available) {
      setProfileEditMessage(t("errUsernameTaken"));
      return;
    }

    const account = await yachatApi.account.update({
      displayName,
      username,
      bio,
      avatarDataUrl,
      avatarAccent: state.account.avatarAccent || "#471AFF"
    });
    state.account = normalizeAccount(account);
    state.editingProfile = false;
    state.profileEditAvatarDataUrl = null;
    state.profileEditMessage = t("profileSaved");
    state.chats = await yachatApi.messenger.chats();
    if (state.activeChatId) {
      state.messages = await yachatApi.messenger.messages(state.activeChatId);
    }
    renderChatList();
    renderActiveChat();
    renderMessages();
    renderPanel();
  } catch (error) {
    setProfileEditMessage(translatedServerMessage(error.message, "errAccountCreate"));
  } finally {
    setLoading(submitButton, false);
  }
}

async function inviteActiveChat(button) {
  const chat = getActiveChat();
  if (!chat || !yachatApi.messenger?.invite) {
    return;
  }

  setLoading(button, true);

  try {
    const result = await yachatApi.messenger.invite({ chatId: chat.id });
    state.chats = result.chats || await yachatApi.messenger.chats();
    renderChatList();
    renderActiveChat();
    renderPanel();
  } catch (error) {
    alert(translatedServerMessage(error.message, "errSendMessage"));
  } finally {
    setLoading(button, false);
  }
}

async function copyActiveInvite() {
  const chat = getActiveChat();
  const invite = chat?.inviteUrl || chat?.inviteCode || "";

  if (!invite) {
    return;
  }

  try {
    await navigator.clipboard?.writeText(invite);
  } catch {
    // Clipboard may be unavailable in some desktop shells.
  }
}

async function leaveActiveChat(button) {
  const chat = getActiveChat();
  if (!chat || chat.locked || !yachatApi.messenger?.leave) {
    alert(t("cannotLeave"));
    return;
  }

  if (!window.confirm(t("leaveChatConfirm"))) {
    return;
  }

  setLoading(button, true);

  try {
    const result = await yachatApi.messenger.leave({ chatId: chat.id });
    state.chats = result.chats || await yachatApi.messenger.chats();
    state.activeChatId = result.activeChatId || state.chats[0]?.id || null;
    state.messages = state.activeChatId ? await yachatApi.messenger.messages(state.activeChatId) : [];
    closePanel();
    renderChatList();
    renderActiveChat();
    renderMessages();
  } catch (error) {
    alert(translatedServerMessage(error.message, "errSendMessage"));
  } finally {
    setLoading(button, false);
  }
}

function stopQrPolling() {
  window.clearTimeout(state.qrPollTimer);
  state.qrPollTimer = null;
}

async function pollQrSession() {
  if (!state.qrSession || !yachatApi.qr?.status) {
    return;
  }

  try {
    const result = await yachatApi.qr.status({
      id: state.qrSession.id,
      token: state.qrSession.token
    });

    if (result.status === "approved" && result.account) {
      stopQrPolling();
      qrStatus.textContent = t("qrApproved");
      showMessenger(result.account);
      return;
    }

    if (result.status === "expired" || result.status === "missing") {
      stopQrPolling();
      qrStatus.textContent = t("qrExpired");
      return;
    }
  } catch {
    // Keep polling while the local server is alive.
  }

  state.qrPollTimer = window.setTimeout(pollQrSession, 1800);
}

async function startQrLogin() {
  if (!qrCodeTarget || !yachatApi.qr?.create) {
    return;
  }

  stopQrPolling();
  qrStatus.textContent = t("qrCreate");
  qrCodeTarget.innerHTML = "";

  try {
    state.qrSession = await yachatApi.qr.create({});
    qrCodeTarget.innerHTML = renderQrSvg(state.qrSession.payload);
    qrStatus.textContent = t("qrWaiting");
    pollQrSession();
  } catch (error) {
    qrStatus.textContent = error.message || t("errCreateCode");
  }
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);

  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }

  return output;
}

async function enablePushNotifications() {
  if (state.notificationsReady || !yachatApi.notifications || !state.account) {
    return;
  }

  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window) || !window.isSecureContext) {
    return;
  }

  const config = await yachatApi.notifications.publicKey();
  if (!config?.enabled || !config.publicKey) {
    return;
  }

  let permission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }

  if (permission !== "granted") {
    return;
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.publicKey)
  });

  await yachatApi.notifications.subscribe(subscription.toJSON());
  state.notificationsReady = true;
}

function applyTranslations() {
  document.documentElement.lang = state.language === "en" ? "en" : "ru";
  document.title = t("appTitle");

  setAttr(".app-shell", "aria-label", "appTitle");
  setAttr('[data-action="open-language"]', "aria-label", "languageAria");
  setAttr('[data-action="open-language-choice"]', "aria-label", "languageAria");
  setAttr('[data-action="toggle-theme"]', "aria-label", "themeAria");
  setAttr('[data-action="open-help"]', "aria-label", "helpAria");
  setAttr(".brand-center", "aria-label", "appTitle");
  setText(".brand-name", "appName");

  setText('[data-screen="phone"] .screen-copy h1', "phoneTitle");
  setText('[data-screen="phone"] .screen-copy p', "phoneSubtitle");
  setAttr(".phone-field", "aria-label", "phoneFieldAria");
  setAttr('[name="phone"]', "placeholder", "phonePlaceholder");
  setText(".field-note", "fieldNote");
  setText("[data-delivery-title]", "deliveryTitle");
  setText("[data-delivery-text]", "deliveryText");
  setText("[data-delivery-yachat]", "deliveryYachat");
  setText("[data-delivery-yachat-hint]", "deliveryYachatHint");
  setText("[data-delivery-telegram]", "deliveryTelegram");
  setText("[data-delivery-telegram-hint]", "deliveryTelegramHint");
  setText('[data-form="phone"] .main-button', "login");
  setText("[data-legal-prefix]", "legalPrefix");
  setText('[data-action="open-policy"]', "policyLink");
  setText("[data-legal-and]", "legalAnd");
  setText('[data-action="open-terms"]', "termsLink");
  setText('[data-action="open-qr"]', "qrLogin");

  setText('[data-screen="code"] .screen-copy h1', "codeTitle");
  setText("[data-code-sent-prefix]", "codeSentPrefix");
  if (!state.challenge) {
    setText("[data-phone-preview]", "phoneFallback");
  }
  setAttr(".code-grid", "aria-label", "codeGridAria");
  setText('[data-form="code"] .main-button', "continue");
  setText('[data-action="back-phone"].muted', "changePhone");
  setText('[data-action="resend-code"]', "resend");

  setText('[data-screen="profile"] .screen-copy h1', "profileTitle");
  setText('[data-screen="profile"] .screen-copy p', "profileSubtitle");
  setAttr(".avatar-preview", "aria-label", "chooseAvatar");
  setText("[data-avatar-title]", "avatar");
  setText("[data-avatar-action]", "chooseAvatar");
  setText('[data-form="profile"] .text-field:nth-of-type(1) span', "name");
  setAttr('[name="displayName"]', "placeholder", "namePlaceholder");
  setText('[data-form="profile"] .text-field:nth-of-type(2) span', "username");
  setAttr('[name="username"]', "placeholder", "usernamePlaceholder");
  setText('[data-form="profile"] .text-field:nth-of-type(3) span', "bio");
  setAttr('[name="bio"]', "placeholder", "bioPlaceholder");
  setText('[data-form="profile"] .main-button', "createAccount");

  setBackButtons();
  setText('[data-screen="qr"] .screen-copy h1', "qrTitle");
  if (!state.qrSession) {
    setText('[data-screen="qr"] .screen-copy p', "qrCreate");
  }
  setAttr(".qr-box", "aria-label", "qrAria");
  setText('[data-action="refresh-qr"]', "resend");

  setText('[data-screen="done"] .screen-copy h1', "accountCreated");
  setText('[data-action="view-account"]', "viewData");
  updateSuccessText();

  setText('[data-screen="language"] .doc-title p', "settings");
  setText('[data-screen="language"] .doc-title h1', "languageTitle");
  setAllText('[data-language-name="ru"]', "russian");
  setAllText('[data-language-name="en"]', "english");

  setText('[data-screen="country"] .doc-title p', "number");
  setText('[data-screen="country"] .doc-title h1', "countryTitle");
  setText('[data-country="RU"]', "countryRu");
  setText('[data-country="BY"]', "countryBy");
  setText('[data-country="KZ"]', "countryKz");
  setAttr("[data-country-search]", "placeholder", "countrySearchPlaceholder");

  setText(".chat-pane-head h1", "chatsTitle");
  setAttr("[data-chat-search]", "placeholder", "search");
  setText('[data-rail="all"] strong', "allChats");
  setText('[data-rail="contacts"] strong', "contacts");
  setText('[data-rail="calls"] strong', "calls");
  setText('[data-rail="settings"] strong', "settings");
  setAttr("[data-message-input]", "placeholder", "messagePlaceholder");
  setText('[data-create-chat-modal] h2', "newChat");
  setText('[data-chat-kind="private"]', "privateChat");
  setText('[data-chat-kind="group"]', "groupChat");
  setText('[data-form="create-chat"] .main-button', "create");
  setText("[data-delete-profile-title]", "deleteProfileConfirmTitle");
  setText("[data-delete-profile-text]", "deleteProfileConfirmText");
  setText("[data-delete-profile-confirm]", "deleteProfileConfirm");
  setAttr("[data-delete-profile-input]", "placeholder", "deleteProfileConfirmPlaceholder");
  setText('[data-action="close-delete-profile"]:not(.icon-button)', "deleteProfileCancel");
  setText("[data-delete-profile-submit]", "deleteProfileConfirmAction");
  renderCreateChatForm();
  hydrateIcons();
  if (state.activePanel) {
    renderPanel();
  }
  renderActiveChat();
  renderChatList();
}

function translatedServerMessage(message, fallbackKey) {
  const key = serverMessageKeys.get(message);
  if (key) {
    return t(key);
  }

  return state.language === "ru" && message ? message : t(fallbackKey);
}

function isLoopbackHostname(hostname) {
  return ["127.0.0.1", "localhost", "::1"].includes(hostname);
}

function upgradeRemoteHttpToHttps() {
  if (window.location.protocol !== "http:" || isLoopbackHostname(window.location.hostname)) {
    return false;
  }

  const secureUrl = new URL(window.location.href);
  secureUrl.protocol = "https:";
  window.location.replace(secureUrl.href);
  return true;
}

function createRuntimeYachatApi() {
  const localApi = createLocalYachatApi();
  upgradeRemoteHttpToHttps();
  const httpApi = createHttpYachatApi(localApi);
  if (httpApi) {
    return httpApi;
  }

  if (window.yachat?.account?.get) {
    return window.yachat;
  }

  return localApi;
}

function createHttpYachatApi(fallbackApi = null) {
  const deviceAuthKey = "yachat-http-device-authorized";
  const authTokenKey = "yachat-http-auth-token";
  const isLoopbackHost = isLoopbackHostname(window.location.hostname);
  if (window.location.protocol !== "https:" && !(window.location.protocol === "http:" && isLoopbackHost)) {
    return null;
  }

  const allowLocalFallback = isLoopbackHost && (
    new URLSearchParams(window.location.search).get("local") === "1" ||
    localStorage.getItem("yachat-dev-local-fallback") === "true"
  );

  function authToken() {
    return localStorage.getItem(authTokenKey) || "";
  }

  function saveSession(payload) {
    const token = payload?.sessionToken || payload?.account?.sessionToken || "";
    if (token) {
      localStorage.setItem(authTokenKey, token);
    }
    return payload;
  }

  function clearSession() {
    localStorage.removeItem(authTokenKey);
    localStorage.removeItem(deviceAuthKey);
  }

  async function request(pathname, options = {}) {
    const token = authToken();
    const response = await fetch(pathname, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.toLowerCase().includes("application/json");
    const payload = isJson ? await response.json().catch(() => null) : null;

    if (!response.ok) {
      const text = isJson ? "" : await response.text().catch(() => "");
      throw new Error(payload?.detail || payload?.error || cleanDisplayText(text, "Request failed."));
    }

    if (!isJson) {
      throw new Error("Сервер вернул не JSON. Проверьте, что Vercel Deployment Protection выключен для публичного сайта.");
    }

    return payload;
  }

  function post(pathname, payload) {
    return request(pathname, {
      method: "POST",
      body: JSON.stringify(payload || {})
    });
  }

  async function withFallback(action, fallback) {
    try {
      return await action();
    } catch (error) {
      if (allowLocalFallback && typeof fallback === "function") {
        return fallback(error);
      }

      throw error;
    }
  }

  return {
    account: {
      get: async () => {
        return withFallback(async () => {
          const account = await request("/api/account");
          if (!account) {
            return null;
          }

          return account;
        }, () => fallbackApi?.account?.get?.() || null);
      },
      createChallenge: (payload) => withFallback(
        () => post("/api/challenge", payload),
        () => fallbackApi?.account?.createChallenge?.(payload)
      ),
      verifyChallenge: (payload) => withFallback(
        () => post("/api/verify", payload).then(saveSession),
        () => fallbackApi?.account?.verifyChallenge?.(payload)
      ),
      create: (payload) => withFallback(
        () => post("/api/account", payload).then(saveSession),
        () => fallbackApi?.account?.create?.(payload)
      ),
      update: (payload) => withFallback(
        () => post("/api/account/update", payload),
        () => fallbackApi?.account?.update?.(payload)
      ),
      deleteProfile: async () => {
        return withFallback(async () => {
          const result = await post("/api/account/delete", {});
          clearSession();
          return result;
        }, () => {
          clearSession();
          return fallbackApi?.account?.deleteProfile?.() || { ok: true };
        });
      },
      logout: async () => {
        const hadToken = Boolean(authToken());
        return withFallback(async () => {
          let result = { ok: true };
          if (hadToken) {
            result = await post("/api/logout", {});
          }
          clearSession();
          return result;
        }, () => {
          clearSession();
          return fallbackApi?.account?.logout?.() || { ok: true };
        });
      }
    },
    server: {
      status: () => withFallback(
        () => request("/api/status"),
        () => fallbackApi?.server?.status?.()
      )
    },
    settings: {
      get: () => withFallback(
        () => request("/api/settings"),
        () => fallbackApi?.settings?.get?.()
      ),
      update: (payload) => withFallback(
        () => post("/api/settings", payload),
        () => fallbackApi?.settings?.update?.(payload)
      )
    },
    users: {
      list: () => withFallback(
        () => request("/api/users"),
        () => fallbackApi?.users?.list?.() || []
      ),
      search: (query) => withFallback(
        () => request(`/api/users/search?q=${encodeURIComponent(query || "")}`),
        () => fallbackApi?.users?.search?.(query) || fallbackApi?.users?.list?.() || []
      ),
      checkUsername: (username) => withFallback(
        () => request(`/api/users/check-username?username=${encodeURIComponent(username || "")}`),
        () => fallbackApi?.users?.checkUsername?.(username) || { username: normalizeUsername(username), available: true }
      )
    },
    contacts: {
      lookup: (payload) => withFallback(
        () => post("/api/contacts/lookup", payload),
        () => fallbackApi?.contacts?.lookup?.(payload) || matchContactsFromUsers(payload?.contacts || [])
      )
    },
    notifications: {
      publicKey: () => withFallback(
        () => request("/api/push/public-key"),
        () => ({ enabled: false, publicKey: "" })
      ),
      subscribe: (payload) => withFallback(
        () => post("/api/push/subscribe", payload),
        () => ({ ok: false })
      )
    },
    messenger: {
      chats: () => withFallback(
        () => request("/api/chats"),
        () => fallbackApi?.messenger?.chats?.()
      ),
      messages: (chatId) => withFallback(
        () => request(`/api/messages?chatId=${encodeURIComponent(chatId)}`),
        () => fallbackApi?.messenger?.messages?.(chatId)
      ),
      createChat: (payload) => withFallback(
        () => post("/api/chat", payload),
        () => fallbackApi?.messenger?.createChat?.(payload)
      ),
      updateChat: (payload) => withFallback(
        () => post("/api/chat/update", payload),
        () => fallbackApi?.messenger?.updateChat?.(payload)
      ),
      invite: (payload) => withFallback(
        () => post("/api/chat/invite", payload),
        () => fallbackApi?.messenger?.invite?.(payload)
      ),
      leave: (payload) => withFallback(
        () => post("/api/chat/leave", payload),
        () => fallbackApi?.messenger?.leave?.(payload)
      ),
      send: (payload) => withFallback(
        () => post("/api/message", payload),
        () => fallbackApi?.messenger?.send?.(payload)
      ),
      updateMessage: (payload) => withFallback(
        () => post("/api/message/update", payload),
        () => fallbackApi?.messenger?.updateMessage?.(payload)
      ),
      deleteMessage: (payload) => withFallback(
        () => post("/api/message/delete", payload),
        () => fallbackApi?.messenger?.deleteMessage?.(payload)
      ),
      markUnread: (payload) => withFallback(
        () => post("/api/message/mark-unread", payload),
        () => fallbackApi?.messenger?.markUnread?.(payload)
      ),
      markRead: (payload) => withFallback(
        () => post("/api/chat/mark-read", payload),
        () => fallbackApi?.messenger?.markRead?.(payload)
      ),
      forwardMessage: (payload) => withFallback(
        () => post("/api/message/forward", payload),
        () => fallbackApi?.messenger?.forwardMessage?.(payload)
      )
    },
    qr: {
      create: (payload) => withFallback(
        () => post("/api/qr/create", payload),
        () => fallbackApi?.qr?.create?.(payload)
      ),
      confirm: (payload) => withFallback(
        () => post("/api/qr/confirm", payload),
        () => fallbackApi?.qr?.confirm?.(payload)
      ),
      status: async (payload) => {
        return withFallback(async () => {
          const result = await post("/api/qr/status", payload);
          if (result.status === "approved" && result.account) {
            saveSession(result);
            localStorage.setItem(deviceAuthKey, "true");
          }
          return result;
        }, () => fallbackApi?.qr?.status?.(payload));
      }
    }
  };
}

function createLocalYachatApi() {
  let challenge = null;
  const accountKey = "yachat-browser-account";
  const settingsKey = "yachat-browser-settings";
  const messengerKey = "yachat-browser-messenger";

  function createCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  function readAccount() {
    try {
      return JSON.parse(localStorage.getItem(accountKey) || "null");
    } catch {
      return null;
    }
  }

  function readSettings() {
    try {
      return JSON.parse(localStorage.getItem(settingsKey) || "null") || {};
    } catch {
      return {};
    }
  }

  function createLocalMessage(chatId, text, author = "system", extra = {}) {
    return {
      id: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `msg-${Date.now()}-${Math.random()}`,
      chatId,
      author,
      text,
      createdAt: new Date().toISOString(),
      attachments: Array.isArray(extra.attachments) ? extra.attachments : [],
      ...extra
    };
  }

  function createDefaultMessenger() {
    const createdAt = new Date().toISOString();
    return {
      chats: [
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
      ],
      messages: {
        "yachat-favorites": [],
        "yachat-codes": [
          createLocalMessage("yachat-codes", "Здесь будут появляться одноразовые коды подтверждения для входа, банков, магазинов и сервисов.", "bot")
        ],
        "yachat-channel": [
          createLocalMessage("yachat-channel", "Канал ЯЧата запущен. Здесь будут новости приложения, изменения и служебные объявления.", "channel")
        ]
      }
    };
  }

  function ensureLocalSystemChats(data) {
    const fallback = createDefaultMessenger();
    const chats = Array.isArray(data?.chats) ? data.chats : [];
    const messages = data?.messages && typeof data.messages === "object" ? data.messages : {};

    fallback.chats.forEach((systemChat) => {
      const existing = chats.find((chat) => chat.id === systemChat.id);
      if (existing) {
        Object.assign(existing, systemChat, { createdAt: existing.createdAt || systemChat.createdAt });
      } else {
        chats.push(systemChat);
      }

      if (!Array.isArray(messages[systemChat.id])) {
        messages[systemChat.id] = fallback.messages[systemChat.id] || [];
      }
    });

    Object.entries(messages).forEach(([chatId, list]) => {
      if (Array.isArray(list)) {
        messages[chatId] = list.filter((message) => !REMOVED_TEST_MESSAGE_TEXTS.has(String(message?.text || "").trim()));
      }
    });

    return {
      ...data,
      chats,
      messages
    };
  }

  function readMessenger() {
    try {
      const stored = JSON.parse(localStorage.getItem(messengerKey) || "null");
      if (stored?.chats && stored?.messages) {
        return writeMessenger(ensureLocalSystemChats(stored));
      }
    } catch {
      // fall through
    }

    const next = createDefaultMessenger();
    localStorage.setItem(messengerKey, JSON.stringify(next));
    return next;
  }

  function writeMessenger(payload) {
    localStorage.setItem(messengerKey, JSON.stringify(payload));
    return payload;
  }

  function localParticipantIds(chat) {
    return [...new Set((Array.isArray(chat?.participantIds) ? chat.participantIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean))];
  }

  function localMessageBelongsToAccount(message, account) {
    const accountId = String(account?.id || "");
    const contact = String(account?.contact || "").trim();
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

  function removeLocalAccountMessengerData(data, account) {
    const accountId = String(account?.id || "");
    const removedChatIds = new Set();
    let removedMessages = 0;

    data.chats = (Array.isArray(data.chats) ? data.chats : []).filter((chat) => {
      const participantIds = localParticipantIds(chat);
      const shouldRemoveChat = participantIds.includes(accountId) || String(chat.ownerId || "") === accountId;

      if (shouldRemoveChat) {
        removedMessages += Array.isArray(data.messages?.[chat.id]) ? data.messages[chat.id].length : 0;
        removedChatIds.add(chat.id);
        return false;
      }

      if (chat.participantProfiles && Object.prototype.hasOwnProperty.call(chat.participantProfiles, accountId)) {
        delete chat.participantProfiles[accountId];
      }

      if (Array.isArray(chat.participantIds)) {
        chat.participantIds = participantIds.filter((id) => id !== accountId);
      }

      return true;
    });

    removedChatIds.forEach((chatId) => {
      delete data.messages[chatId];
    });

    Object.entries(data.messages || {}).forEach(([chatId, messages]) => {
      if (!Array.isArray(messages)) {
        return;
      }

      const wipeSavedMessages = chatId === "yachat-favorites";
      const nextMessages = messages.filter((message) => !(wipeSavedMessages || localMessageBelongsToAccount(message, account)));

      if (nextMessages.length !== messages.length) {
        removedMessages += messages.length - nextMessages.length;
        data.messages[chatId] = nextMessages;
      }
    });

    return {
      removedChats: removedChatIds.size,
      removedMessages
    };
  }

  function countUnreadMessages(chat, messages) {
    if (!chat?.manualUnread || !Array.isArray(messages) || messages.length === 0) {
      return 0;
    }

    const unreadMessageId = String(chat.unreadMessageId || "");
    const startIndex = unreadMessageId
      ? messages.findIndex((message) => message.id === unreadMessageId)
      : -1;

    return startIndex >= 0 ? messages.length - startIndex : 1;
  }

  function summarizeLocalChats(data) {
    const account = readAccount()?.account || null;
    return data.chats.filter((chat) => {
      const ids = localParticipantIds(chat);
      return ids.length === 0 || Boolean(account?.id && ids.includes(account.id));
    }).map((chat) => {
      const messages = data.messages[chat.id] || [];
      const last = messages[messages.length - 1];
      const attachment = last?.attachments?.[0];
      const attachmentText = attachment?.kind === "image"
        ? "Фото"
        : attachment?.kind === "video"
          ? "Видео"
          : attachment
          ? "Файл"
          : "";
      const ids = localParticipantIds(chat);
      const participantProfiles = chat.participantProfiles || {};
      const otherId = ids.find((id) => id !== account?.id) || ids[0];
      const other = participantProfiles[otherId] || null;
      return {
        ...chat,
        title: chat.kind === "private" && other ? other.displayName || other.previewName || other.username || chat.title : chat.title,
        subtitle: chat.kind === "private" && other?.username ? `@${other.username}` : chat.subtitle,
        avatarDataUrl: chat.kind === "private" && other?.avatarDataUrl ? other.avatarDataUrl : chat.avatarDataUrl,
        lastMessage: last?.text || attachmentText,
        lastAt: last?.createdAt || chat.createdAt,
        unread: countUnreadMessages(chat, messages)
      };
    }).sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }

      return String(b.lastAt || "").localeCompare(String(a.lastAt || ""));
    });
  }

  return {
    account: {
      get: async () => readAccount()?.account || null,
      createChallenge: async (payload) => {
        if (payload?.deliveryMethod === "telegram") {
          throw new Error("Telegram is not linked for this number. Start the YaChat code bot and share your phone number first.");
        }

        const code = createCode();
        challenge = {
          method: payload?.method === "phone" ? "phone" : "email",
          contact: String(payload?.contact || "").trim(),
          code,
          expiresAt: Date.now() + 10 * 60 * 1000
        };

        if (!challenge.contact) {
          throw new Error(t("errEnterPhone"));
        }

        const messenger = readMessenger();
        messenger.messages["yachat-codes"] = [
          ...(messenger.messages["yachat-codes"] || []),
          createLocalMessage("yachat-codes", `Код подтверждения ЯЧата для ${challenge.contact}: ${code}. Он действует 10 минут. Никому его не сообщайте.`, "bot")
        ];
        writeMessenger(messenger);

        const result = {
          method: challenge.method,
          contact: challenge.contact,
          expiresAt: challenge.expiresAt,
          deliveryMethod: "yachat",
          delivery: { yachat: true, telegram: false, dev: false }
        };
        if (localStorage.getItem("yachat-dev-return-code") === "true") {
          result.devCode = code;
          result.delivery.dev = true;
        }
        return result;
      },
      verifyChallenge: async (payload) => {
        if (!challenge) {
          return { ok: false, reason: t("errRequestCodeFirst") };
        }

        if (Date.now() > challenge.expiresAt) {
          challenge = null;
          return { ok: false, reason: t("errExpiredCode") };
        }

        if (String(payload?.code || "") !== challenge.code) {
          return { ok: false, reason: t("errWrongCode") };
        }

        challenge.verifiedAt = Date.now();
        const verifiedChallenge = challenge;
        const existingAccount = readAccount()?.account || null;

        if (existingAccount && String(existingAccount.contact || "").trim() === verifiedChallenge.contact) {
          challenge = null;
          return {
            ok: true,
            contact: verifiedChallenge.contact,
            method: verifiedChallenge.method,
            account: existingAccount,
            accountExists: true
          };
        }

        return {
          ok: true,
          contact: verifiedChallenge.contact,
          method: verifiedChallenge.method,
          account: null,
          accountExists: false
        };
      },
      create: async (payload) => {
        if (!challenge?.verifiedAt) {
          throw new Error(t("errConfirmCodeFirst"));
        }

        const displayName = String(payload?.displayName || "").trim();
        const username = createProfileUsername(displayName, payload?.username);
        const bio = String(payload?.bio || "").trim();

        if (!displayName) {
          throw new Error(t("errName"));
        }

        if (bio.length > 140) {
          throw new Error(t("errBio"));
        }

        const account = {
          id: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `local-${Date.now()}`,
          title: "ЯЧат",
          displayName,
          username,
          bio,
          contact: challenge.contact,
          method: challenge.method,
          avatarDataUrl: String(payload?.avatarDataUrl || ""),
          avatarAccent: "#471AFF",
          createdAt: new Date().toISOString(),
          status: "account-created"
        };

        localStorage.setItem(accountKey, JSON.stringify({ account }));
        challenge = null;
        return account;
      },
      update: async (payload) => {
        const stored = readAccount();
        const account = stored?.account || null;
        if (!account?.id) {
          throw new Error(t("errConfirmCodeFirst"));
        }

        const displayName = String(payload?.displayName || "").trim();
        const username = normalizeUsername(payload?.username);
        const bio = String(payload?.bio || "").trim();

        if (!displayName) {
          throw new Error(t("errName"));
        }

        if (!username) {
          throw new Error(t("errUsername"));
        }

        if (bio.length > 140) {
          throw new Error(t("errBio"));
        }

        const next = {
          ...account,
          displayName,
          username,
          bio,
          avatarDataUrl: String(payload?.avatarDataUrl || ""),
          avatarAccent: String(payload?.avatarAccent || account.avatarAccent || "#471AFF"),
          updatedAt: new Date().toISOString()
        };
        localStorage.setItem(accountKey, JSON.stringify({ account: next }));
        return next;
      },
      logout: async () => {
        localStorage.removeItem(accountKey);
        return { ok: true };
      },
      deleteProfile: async () => {
        const account = readAccount()?.account || null;
        localStorage.removeItem(accountKey);
        challenge = null;

        if (account?.id) {
          const data = readMessenger();
          const cleanup = removeLocalAccountMessengerData(data, account);
          writeMessenger(data);
          return { ok: true, deleted: true, removedAttachments: 0, ...cleanup };
        }

        return { ok: true, deleted: false, removedChats: 0, removedMessages: 0, removedAttachments: 0 };
      }
    },
    server: {
      status: async () => ({
        storage: "browser-local",
        users: "encrypted-browser-fallback",
        webUrl: null,
        lanUrl: null,
        encryption: {
          storage: "localStorage-dev-fallback",
          kdf: "none",
          identity: "browser"
        }
      })
    },
    settings: {
      get: async () => {
        const settings = readSettings();
        const themeSource = normalizeThemeSource(settings.themeSource || localStorage.getItem(THEME_SOURCE_STORAGE_KEY));

        return {
          ...settings,
          language: localStorage.getItem("yachat-language") || settings.language || "ru",
          theme: themeSource === "manual"
            ? normalizeTheme(settings.theme || localStorage.getItem(THEME_STORAGE_KEY), systemTheme())
            : systemTheme(),
          themeSource,
          country: settings.country || "RU",
          countryCode: settings.countryCode || "+7"
        };
      },
      update: async (payload) => {
        const next = {
          ...readSettings(),
          ...payload,
          updatedAt: new Date().toISOString()
        };
        localStorage.setItem(settingsKey, JSON.stringify(next));
        if (next.language) {
          localStorage.setItem("yachat-language", next.language);
        }
        return next;
      }
    },
    users: {
      list: async () => {
        const account = readAccount()?.account;
        return account ? [account] : [];
      },
      search: async (query) => {
        const value = String(query || "").trim().toLowerCase();
        const account = readAccount()?.account;

        if (!account || !value) {
          return [];
        }

        return userSearchText(account).includes(value) ? [account] : [];
      },
      checkUsername: async (username) => {
        const normalized = normalizeUsername(username);
        const account = readAccount()?.account || null;
        return {
          username: normalized,
          available: Boolean(normalized) && (!account?.username || normalizeUsername(account.username) === normalized)
        };
      }
    },
    contacts: {
      lookup: async (payload) => {
        const contacts = uniqueContactPhones(payload?.contacts || []);
        const requested = new Set(contacts.flatMap((phone) => [...contactMatchKeys(phone)]));
        const account = readAccount()?.account;

        if (!account || requested.size === 0 || account.id === state.account?.id) {
          return [];
        }

        return [...contactMatchKeys(account.contact)].some((key) => requested.has(key))
          ? [account]
          : [];
      }
    },
    messenger: {
      chats: async () => summarizeLocalChats(readMessenger()),
      messages: async (chatId) => readMessenger().messages[chatId] || [],
      createChat: async (payload) => {
        const data = readMessenger();
        const account = readAccount()?.account;
        const kind = payload?.kind === "group" ? "group" : "private";
        const selectedIds = [...new Set((Array.isArray(payload?.participantIds) ? payload.participantIds : [])
          .map((id) => String(id || "").trim())
          .filter((id) => id && id !== account?.id))];
        const incomingProfiles = payload?.participantProfiles && typeof payload.participantProfiles === "object"
          ? payload.participantProfiles
          : {};
        const selectedProfile = incomingProfiles[selectedIds[0]] || null;

        if (!account?.id) {
          throw new Error(t("errConfirmCodeFirst"));
        }

        if (kind === "private" && selectedIds.length !== 1) {
          throw new Error(t("errChoosePerson"));
        }

        if (kind === "group" && selectedIds.length < 1) {
          throw new Error(t("errChooseGroupMember"));
        }

        const title = kind === "group"
          ? String(payload?.title || "").trim()
          : String(selectedProfile?.displayName || selectedProfile?.previewName || payload?.title || "").trim() || t("privateChat");

        if (kind === "group" && !title) {
          throw new Error(t("errGroupName"));
        }

        const participantIds = [account.id, ...selectedIds];
        const participantProfiles = {
          [account.id]: {
            id: account.id,
            username: account.username,
            displayName: account.displayName,
            previewName: account.displayName,
            avatarDataUrl: account.avatarDataUrl || ""
          }
        };
        selectedIds.forEach((id) => {
          const profile = incomingProfiles[id];
          if (!profile) {
            return;
          }

          const username = cleanDisplayText(profile.username, "user");
          const displayName = cleanDisplayText(profile.displayName || profile.previewName, username);
          participantProfiles[id] = {
            id,
            username,
            displayName,
            previewName: displayName,
            contact: cleanDisplayText(profile.contact, ""),
            avatarDataUrl: profile.avatarDataUrl || "",
            avatarAccent: profile.avatarAccent || "#471AFF"
          };
        });

        if (kind === "private") {
          const pair = [...participantIds].sort().join(":");
          const existing = data.chats.find((chat) => (
            chat.kind === "private" &&
            localParticipantIds(chat).sort().join(":") === pair
          ));

          if (existing) {
            return {
              chat: existing,
              chats: summarizeLocalChats(data),
              messages: data.messages[existing.id] || []
            };
          }
        }

        const chat = {
          id: `${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          kind,
          title,
          subtitle: kind === "group" ? "Группа" : "Личный чат",
          description: String(payload?.description || "").trim().slice(0, 180),
          participantIds,
          participantProfiles,
          locked: false,
          verified: false,
          pinned: false,
          canSend: true,
          avatar: kind,
          avatarDataUrl: String(payload?.avatarDataUrl || ""),
          ownerId: readAccount()?.account?.id || null,
          inviteCode: null,
          inviteUrl: null,
          createdAt: new Date().toISOString()
        };

        data.chats.push(chat);
        data.messages[chat.id] = [
          createLocalMessage(chat.id, kind === "group" ? "Группа создана." : "Чат создан.", "system")
        ];
        writeMessenger(data);
        return {
          chat,
          chats: summarizeLocalChats(data),
          messages: data.messages[chat.id]
        };
      },
      updateChat: async (payload) => {
        const data = readMessenger();
        const chat = data.chats.find((item) => item.id === payload?.chatId);

        if (!chat) {
          throw new Error("Чат не найден.");
        }

        if (chat.locked || chat.kind !== "group") {
          throw new Error("Нет прав на изменение этого чата.");
        }

        if (Object.prototype.hasOwnProperty.call(payload || {}, "title")) {
          const title = String(payload.title || "").trim().slice(0, 60);
          if (!title) {
            throw new Error("Введите название чата.");
          }
          chat.title = title;
        }

        if (Object.prototype.hasOwnProperty.call(payload || {}, "description")) {
          chat.description = String(payload.description || "").trim().slice(0, 180);
          chat.subtitle = chat.description || (chat.kind === "group" ? "Группа" : "Личный чат");
        }

        if (Object.prototype.hasOwnProperty.call(payload || {}, "avatarDataUrl")) {
          chat.avatarDataUrl = String(payload.avatarDataUrl || "");
        }

        chat.updatedAt = new Date().toISOString();
        writeMessenger(data);
        return {
          chat,
          chats: summarizeLocalChats(data),
          messages: data.messages[chat.id] || []
        };
      },
      invite: async (payload) => {
        const data = readMessenger();
        const chat = data.chats.find((item) => item.id === payload?.chatId);

        if (!chat) {
          throw new Error("Чат не найден.");
        }

        if (chat.kind !== "group") {
          throw new Error("Приглашения доступны только для групп.");
        }

        chat.inviteCode = chat.inviteCode || `YC-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
        chat.inviteUrl = `yachat://join/${chat.inviteCode}`;
        writeMessenger(data);
        return {
          chat,
          chats: summarizeLocalChats(data),
          inviteCode: chat.inviteCode,
          inviteUrl: chat.inviteUrl
        };
      },
      leave: async (payload) => {
        const data = readMessenger();
        const chat = data.chats.find((item) => item.id === payload?.chatId);

        if (!chat) {
          throw new Error("Чат не найден.");
        }

        if (chat.locked) {
          throw new Error("Из этого чата нельзя выйти.");
        }

        data.chats = data.chats.filter((item) => item.id !== chat.id);
        delete data.messages[chat.id];
        writeMessenger(data);
        return {
          chats: summarizeLocalChats(data),
          activeChatId: data.chats[0]?.id || null
        };
      },
      send: async (payload) => {
        const data = readMessenger();
        const chat = data.chats.find((item) => item.id === payload?.chatId);
        const text = String(payload?.text || "").trim();
        const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
        const replySource = (data.messages[chat?.id] || []).find((item) => item.id === payload?.replyToMessageId);
        const replyTo = replySource ? {
          messageId: replySource.id,
          author: replySource.author,
          text: String(replySource.text || "").slice(0, 160)
        } : null;

        if (!chat) {
          throw new Error("Чат не найден.");
        }

        if (chat.canSend === false) {
          throw new Error("В этот канал нельзя писать.");
        }

        if (!text && attachments.length === 0) {
          throw new Error("Введите сообщение.");
        }

        data.messages[chat.id] = [
          ...(data.messages[chat.id] || []),
          createLocalMessage(chat.id, text, "user", { attachments, ...(replyTo ? { replyTo } : {}) })
        ];
        chat.manualUnread = false;
        chat.unreadMessageId = "";

        if (chat.id === "yachat-codes") {
          data.messages[chat.id].push(createLocalMessage(
            chat.id,
            "Я принимаю только системные коды и служебные подтверждения. Обычные сообщения сохраняю здесь локально.",
            "bot"
          ));
        }

        writeMessenger(data);
        return {
          chats: summarizeLocalChats(data),
          messages: data.messages[chat.id]
        };
      },
      updateMessage: async (payload) => {
        const data = readMessenger();
        const chat = data.chats.find((item) => item.id === payload?.chatId);
        const text = String(payload?.text || "").trim();

        if (!chat) {
          throw new Error("Чат не найден.");
        }

        if (!text) {
          throw new Error("Введите сообщение.");
        }

        const message = (data.messages[chat.id] || []).find((item) => item.id === payload?.messageId);
        if (!message || message.author !== "user") {
          throw new Error("Это сообщение нельзя редактировать.");
        }

        message.text = text;
        message.editedAt = new Date().toISOString();
        writeMessenger(data);
        return {
          chats: summarizeLocalChats(data),
          messages: data.messages[chat.id] || []
        };
      },
      deleteMessage: async (payload) => {
        const data = readMessenger();
        const chat = data.chats.find((item) => item.id === payload?.chatId);
        const ids = [...new Set((Array.isArray(payload?.messageIds) ? payload.messageIds : [payload?.messageId])
          .map((id) => String(id || "").trim())
          .filter(Boolean))];

        if (!chat) {
          throw new Error("Чат не найден.");
        }

        const removing = new Set(ids);
        data.messages[chat.id] = (data.messages[chat.id] || []).filter((message) => !removing.has(message.id));
        writeMessenger(data);
        return {
          chats: summarizeLocalChats(data),
          messages: data.messages[chat.id] || []
        };
      },
      markUnread: async (payload) => {
        const data = readMessenger();
        const chat = data.chats.find((item) => item.id === payload?.chatId);

        if (!chat) {
          throw new Error("Чат не найден.");
        }

        const list = data.messages[chat.id] || [];
        const messageId = String(payload?.messageId || "");
        const message = list.find((item) => item.id === messageId);

        if (!message) {
          throw new Error("Сообщение не найдено.");
        }

        chat.manualUnread = true;
        chat.unreadMessageId = message.id;
        writeMessenger(data);
        return {
          chats: summarizeLocalChats(data),
          messages: data.messages[chat.id] || []
        };
      },
      markRead: async (payload) => {
        const data = readMessenger();
        const chat = data.chats.find((item) => item.id === payload?.chatId);

        if (!chat) {
          throw new Error("Чат не найден.");
        }

        chat.manualUnread = false;
        chat.unreadMessageId = "";
        writeMessenger(data);
        return {
          chats: summarizeLocalChats(data),
          messages: data.messages[chat.id] || []
        };
      },
      forwardMessage: async (payload) => {
        const data = readMessenger();
        const fromChat = data.chats.find((item) => item.id === payload?.fromChatId);
        const toChat = data.chats.find((item) => item.id === payload?.toChatId);
        const source = (data.messages[fromChat?.id] || []).find((item) => item.id === payload?.messageId);

        if (!fromChat || !toChat || !source) {
          throw new Error("Сообщение не найдено.");
        }

        if (toChat.canSend === false) {
          throw new Error("В этот канал нельзя писать.");
        }

        data.messages[toChat.id] = [
          ...(data.messages[toChat.id] || []),
          createLocalMessage(toChat.id, source.text || "", "user", {
            attachments: Array.isArray(source.attachments) ? source.attachments : [],
            forwardedFrom: fromChat.title || ""
          })
        ];
        toChat.manualUnread = false;
        toChat.unreadMessageId = "";
        writeMessenger(data);
        return {
          chats: summarizeLocalChats(data),
          messages: data.messages[toChat.id] || [],
          chatId: toChat.id
        };
      }
    },
    qr: {
      create: async () => {
        const id = Math.random().toString(36).slice(2, 10);
        const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
        const session = {
          id,
          token,
          payload: JSON.stringify({ a: "yc", t: "l", i: id, k: token }),
          status: "pending",
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        };
        localStorage.setItem(`yachat-qr-${id}`, JSON.stringify(session));
        return session;
      },
      confirm: async (payload) => {
        let parsed = null;
        try {
          parsed = JSON.parse(String(payload?.payload || ""));
        } catch {
          // Not a JSON QR token.
        }

        if (!parsed || parsed.a !== "yc" || parsed.t !== "l" || !parsed.i || !parsed.k) {
          throw new Error("QR-код ЯЧата не распознан.");
        }
        const key = `yachat-qr-${parsed.i}`;
        const session = JSON.parse(localStorage.getItem(key) || "null");
        if (!session || session.token !== parsed.k) {
          throw new Error("Сессия не найдена.");
        }
        session.status = "approved";
        session.account = readAccount()?.account || null;
        localStorage.setItem(key, JSON.stringify(session));
        return { ok: true, status: "approved", account: session.account };
      },
      status: async (payload) => {
        const key = `yachat-qr-${payload?.id}`;
        const session = JSON.parse(localStorage.getItem(key) || "null");
        if (!session || session.token !== payload?.token) {
          return { status: "missing" };
        }
        return {
          id: session.id,
          status: session.status,
          expiresAt: session.expiresAt,
          account: session.status === "approved" ? session.account : null
        };
      }
    }
  };
}

function setTheme(theme, persist = true, source = "manual") {
  state.themeSource = normalizeThemeSource(source);
  state.theme = state.themeSource === "system"
    ? systemTheme()
    : normalizeTheme(theme, systemTheme());
  document.documentElement.dataset.theme = state.theme;

  if (state.themeSource === "manual") {
    localStorage.setItem(THEME_STORAGE_KEY, state.theme);
    localStorage.setItem(THEME_SOURCE_STORAGE_KEY, "manual");
  } else {
    localStorage.removeItem(THEME_STORAGE_KEY);
    localStorage.setItem(THEME_SOURCE_STORAGE_KEY, "system");
  }

  hydrateIcons();

  if (state.activePanel) {
    renderPanel();
  }
}

function syncSystemTheme() {
  if (state.themeSource === "system") {
    setTheme(systemTheme(), false, "system");
  }
}

function setLanguage(language, persist = true) {
  state.language = language === "en" ? "en" : "ru";
  localStorage.setItem("yachat-language", state.language);
  applyTranslations();

  if (languageCurrent) {
    languageCurrent.textContent = state.language.toUpperCase();
  }

  document.querySelectorAll(".form-message").forEach((element) => {
    element.textContent = "";
  });

  document.querySelectorAll("[data-language]").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.language === state.language);
  });

  if (persist) {
    yachatApi.settings?.update({ language: state.language }).catch(() => {});
  }
}

function closeLanguageChoice() {
  if (languageChoice) {
    languageChoice.hidden = true;
  }
}

function getCountryOption(country = state.country) {
  return COUNTRY_BY_CODE.get(country) || COUNTRY_OPTIONS[0];
}

function phoneLengthLabel(option = getCountryOption()) {
  return option.min === option.max ? String(option.max) : `${option.min}-${option.max}`;
}

function isValidPhoneLength(length, option = getCountryOption()) {
  return length >= option.min && length <= option.max;
}

function closeCountryChoice() {
  if (countryChoice) {
    countryChoice.hidden = true;
  }
}

function openLanguageChoice() {
  if (!languageChoice) {
    return;
  }

  closeCountryChoice();
  languageChoice.hidden = !languageChoice.hidden;
}

function renderCountryChoice() {
  if (!countryList) {
    return;
  }

  const query = String(countrySearch?.value || "").trim().toLowerCase();
  const digitsQuery = digitsOnly(query);
  const options = COUNTRY_OPTIONS.filter((option) => {
    if (!query) {
      return true;
    }

    return [
      option.country,
      option.name,
      option.code,
      option.code.replace(/\D/g, "")
    ].some((value) => String(value).toLowerCase().includes(query) || (digitsQuery && String(value).includes(digitsQuery)));
  });

  countryList.innerHTML = options.map((option) => `
    <button class="country-choice-row${option.country === state.country ? " is-selected" : ""}" type="button" data-country="${escapeHtml(option.country)}">
      <span>${escapeHtml(option.country)}</span>
      <strong>${escapeHtml(option.name)}</strong>
      <small>${escapeHtml(option.code)}</small>
    </button>
  `).join("");
}

function openCountryChoice() {
  if (!countryChoice) {
    return;
  }

  closeLanguageChoice();
  countryChoice.hidden = !countryChoice.hidden;
  renderCountryChoice();
  if (!countryChoice.hidden) {
    requestAnimationFrame(() => countrySearch?.focus());
  }
}

function setCountry(country, countryCode, persist = true) {
  const option = COUNTRY_BY_CODE.get(country) || COUNTRY_OPTIONS.find((item) => item.code === countryCode) || COUNTRY_OPTIONS[0];
  state.country = option.country;
  state.countryCode = option.code;
  const countryLabel = document.querySelector("[data-country-label]");
  const countryCodeLabel = document.querySelector("[data-country-code]");

  if (countryLabel) {
    countryLabel.textContent = option.country;
  }

  if (countryCodeLabel) {
    countryCodeLabel.textContent = option.code;
  }

  document.querySelectorAll("[data-country]").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.country === state.country);
  });

  renderCountryChoice();
  normalizePhone();

  if (persist) {
    yachatApi.settings?.update({
      country: state.country,
      countryCode: state.countryCode
    }).catch(() => {});
  }
}

async function loadServerState() {
  try {
    const settings = await yachatApi.settings?.get();
    if (settings) {
      setLanguage(settings.language || "ru", false);
      setCountry(settings.country || "RU", settings.countryCode || "+7", false);
    }
  } catch {
    setLanguage(state.language, false);
    setCountry(state.country, state.countryCode, false);
  }

}

function canUseHistoryRoutes() {
  return window.location.protocol === "http:" || window.location.protocol === "https:";
}

function pageFileForPath(path) {
  if (path === "/privacy") {
    return "privacy.html";
  }

  return `${path.replace(/^\//, "")}.html`;
}

async function pageUrlFor(page) {
  const path = standalonePagePaths.get(page);

  if (!path) {
    return null;
  }

  if (canUseHistoryRoutes()) {
    return new URL(path, window.location.origin).href;
  }

  try {
    const status = await yachatApi.server?.status?.();
    if (status?.webUrl) {
      return new URL(path, status.webUrl).href;
    }
  } catch {
    // Fall back to a direct file URL below.
  }

  return new URL(pageFileForPath(path), window.location.href).href;
}

async function openStandalonePage(page) {
  const url = await pageUrlFor(page);

  if (!url) {
    return;
  }

  if (window.yachat?.links?.openExternal) {
    try {
      await window.yachat.links.openExternal(url);
      return;
    } catch {
      // Browser fallback below keeps the link usable if the shell bridge fails.
    }
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

function setScreen(nextScreen, options = {}) {
  if (!secondaryScreens.has(nextScreen) && nextScreen !== state.screen) {
    state.previousScreen = nextScreen;
  }

  if (secondaryScreens.has(nextScreen) && !secondaryScreens.has(state.screen)) {
    state.previousScreen = state.screen;
  }

  if (options.previousScreen) {
    state.previousScreen = options.previousScreen;
  }

  state.screen = nextScreen;
  screens.forEach((screen) => {
    screen.classList.toggle("is-active", screen.dataset.screen === nextScreen);
  });

  document.querySelector(".brand-center").classList.toggle("is-compact", secondaryScreens.has(nextScreen));
  document.querySelector(".auth-card").classList.toggle("is-page", secondaryScreens.has(nextScreen));

  if (nextScreen === "code") {
    requestAnimationFrame(() => codeInputs[0]?.focus());
  }

  if (nextScreen === "qr") {
    startQrLogin();
  } else {
    stopQrPolling();
  }

  if (nextScreen === "profile") {
    requestAnimationFrame(() => profileForm.elements.displayName?.focus());
  }

  if (nextScreen === "delivery") {
    requestAnimationFrame(() => deliveryButtons[0]?.focus());
  }

  if (options.focusPhone) {
    requestAnimationFrame(() => phoneInput.focus());
  }
}

function backHome() {
  if (state.previousScreen === "messenger" && state.account) {
    showMessenger(state.account);
    return;
  }

  setScreen(state.previousScreen || "phone", { skipRoute: true });
}

function setMessage(scope, text, type = "error") {
  const target = document.querySelector(`[data-message="${scope}"]`);
  if (!target) {
    return;
  }

  target.textContent = text || "";
  target.dataset.type = type;
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function getPhoneGroups(option, digits) {
  const groups = PHONE_GROUPS_BY_COUNTRY[option.country];
  return typeof groups === "function" ? groups(digits) : groups || DEFAULT_PHONE_GROUPS;
}

function splitPhoneDigits(digits, groups) {
  const parts = [];
  let offset = 0;

  groups.forEach((size) => {
    const part = digits.slice(offset, offset + size);
    if (part) {
      parts.push(part);
    }
    offset += size;
  });

  if (offset < digits.length) {
    parts.push(digits.slice(offset));
  }

  return parts.join(" ");
}

function formatPhone(value) {
  const option = getCountryOption();
  const codeDigits = option.code.replace(/\D/g, "");
  let source = digitsOnly(value);

  if (source.length > option.max && source.startsWith(codeDigits)) {
    source = source.slice(codeDigits.length);
  }

  if (source.length > option.max && option.code === "+7" && source.startsWith("8")) {
    source = source.slice(1);
  }

  const digits = source.slice(0, option.max);
  return splitPhoneDigits(digits, getPhoneGroups(option, digits));
}

function normalizePhone() {
  phoneInput.value = formatPhone(phoneInput.value);
  phoneButton.disabled = !isValidPhoneLength(digitsOnly(phoneInput.value).length);
}

function setLoading(button, isLoading) {
  if (!button) {
    return;
  }

  button.disabled = isLoading;
  button.classList.toggle("is-loading", isLoading);
}

function fillCode(value) {
  setCodeState("idle");
  const digits = digitsOnly(value).slice(0, 6);
  codeInputs.forEach((input, index) => {
    input.value = digits[index] || "";
  });
  codeButton.disabled = digits.length !== 6;

  const focusIndex = Math.min(digits.length, codeInputs.length - 1);
  codeInputs[focusIndex]?.focus();
}

function readCode() {
  return codeInputs.map((input) => input.value).join("");
}

function validateProfile() {
  const displayName = profileForm.elements.displayName.value.trim();
  profileButton.disabled = displayName.length === 0;
}

function suggestUsername(displayName) {
  const translitMap = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "c",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya"
  };

  return String(displayName || "")
    .trim()
    .toLowerCase()
    .split("")
    .map((char) => translitMap[char] ?? char)
    .join("")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

function normalizeUsernameInput(input) {
  if (!input) {
    return "";
  }

  const normalized = normalizeUsername(input.value);
  if (input.value !== normalized) {
    input.value = normalized;
  }
  return normalized;
}

function createProfileUsername(displayName, preferredUsername) {
  let username = normalizeUsername(preferredUsername) || suggestUsername(displayName) || "user";

  if (username.length < 3) {
    username = `${username || "user"}_${Math.floor(1000 + Math.random() * 9000)}`;
  }

  return username.slice(0, 24);
}

async function ensureUsernameAvailable(username) {
  const normalized = normalizeUsername(username);
  if (!normalized || normalized.length < 3) {
    return { username: normalized, available: false };
  }

  if (!yachatApi.users?.checkUsername) {
    return { username: normalized, available: true };
  }

  return yachatApi.users.checkUsername(normalized);
}

function setDeliveryMethod(method) {
  state.verificationDeliveryMethod = method === "telegram" ? "telegram" : "yachat";
  deliveryButtons.forEach((button) => {
    const selected = button.dataset.deliveryMethod === state.verificationDeliveryMethod;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function setDeliveryButtonsLoading(activeButton, isLoading) {
  deliveryButtons.forEach((button) => {
    button.disabled = isLoading;
    button.classList.toggle("is-loading", isLoading && button === activeButton);
  });
}

function validLoginContact() {
  const phone = digitsOnly(phoneInput.value);
  const option = getCountryOption();
  if (!isValidPhoneLength(phone.length, option)) {
    setMessage("phone", t("errPhoneDigits", { count: phoneLengthLabel(option) }));
    return "";
  }

  return `${state.countryCode} ${phoneInput.value}`;
}

function closeDeliveryModal(returnToPhone = true) {
  state.deliveryActionButton = null;
  setDeliveryButtonsLoading(null, false);
  if (returnToPhone) {
    setScreen("phone", { focusPhone: true });
  }
}

function openDeliveryModal(actionButton) {
  const contact = validLoginContact();
  if (!contact) {
    return;
  }

  state.deliveryActionButton = actionButton || null;
  setMessage("phone", "");
  setDeliveryMethod("");
  if (deliveryContact) {
    deliveryContact.textContent = contact;
  }
  setScreen("delivery");
}

async function createChallenge(deliveryMethod, sourceButton) {
  const contact = validLoginContact();
  if (!contact) {
    closeDeliveryModal();
    return;
  }

  const actionButton = state.deliveryActionButton;
  setDeliveryMethod(deliveryMethod);
  setDeliveryButtonsLoading(sourceButton, true);
  setLoading(actionButton, true);
  setMessage("phone", "");

  try {
    const challenge = await yachatApi.account.createChallenge({
      method: "phone",
      contact,
      deliveryMethod: state.verificationDeliveryMethod
    });
    state.challenge = challenge;
    const phonePreview = document.querySelector("[data-phone-preview]");
    if (phonePreview) {
      phonePreview.textContent = challenge.contact;
    }
    fillCode("");
    closeDeliveryModal(false);
    setScreen("code");
    const delivery = challenge.delivery || {};
    const deliveryKey = delivery.yachat && delivery.telegram
      ? "codeDeliveryBoth"
      : delivery.yachat
        ? "codeDeliveryYachat"
        : delivery.telegram
          ? "codeDeliveryTelegram"
          : "codeDeliveryHint";
    setMessage("code", t(deliveryKey), "success");
  } catch (error) {
    setMessage("phone", translatedServerMessage(error.message, "errCreateCode"));
    setScreen("phone", { focusPhone: true });
  } finally {
    setDeliveryButtonsLoading(sourceButton, false);
    setLoading(actionButton, false);
    normalizePhone();
  }
}

async function verifyChallenge(submitButton) {
  const code = readCode();
  if (code.length !== 6) {
    setCodeState("error");
    setMessage("code", t("errCodeDigits"));
    return;
  }

  setLoading(submitButton, true);
  setMessage("code", "");
  setCodeState("idle");

  try {
    const result = await yachatApi.account.verifyChallenge({
      code,
      contact: state.challenge?.contact || ""
    });
    if (!result.ok) {
      setCodeState("error");
      setMessage("code", translatedServerMessage(result.reason, "errCodeFailed"));
      return;
    }
    setCodeState("success");
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    if (result.accountExists && result.account) {
      state.account = normalizeAccount(result.account);
      state.accountTextMode = "existing";
      state.challenge = null;
      showMessenger(result.account);
      return;
    }
    state.challenge = {
      ...state.challenge,
      registrationToken: result.registrationToken || "",
      method: result.method || state.challenge?.method || "phone",
      contact: result.contact || state.challenge?.contact || ""
    };
    setScreen("profile");
  } catch (error) {
    setCodeState("error");
    setMessage("code", translatedServerMessage(error.message, "errVerify"));
  } finally {
    setLoading(submitButton, false);
    codeButton.disabled = readCode().length !== 6;
  }
}

async function createAccount(submitButton) {
  const formData = new FormData(profileForm);
  const displayName = String(formData.get("displayName") || "").trim();
  const username = createProfileUsername(displayName, formData.get("username"));
  const payload = {
    displayName,
    username,
    bio: String(formData.get("bio") || "").trim(),
    avatarDataUrl: state.avatarDataUrl,
    registrationToken: state.challenge?.registrationToken || "",
    contact: state.challenge?.contact || "",
    method: state.challenge?.method || "phone"
  };

  setLoading(submitButton, true);
  setMessage("profile", "");

  try {
    setMessage("profile", t("usernameChecking"), "success");
    const usernameStatus = await ensureUsernameAvailable(username);
    if (!usernameStatus.available) {
      setMessage("profile", t("errUsernameTaken"));
      return;
    }
    setMessage("profile", "");
    const account = await yachatApi.account.create(payload);
    state.account = normalizeAccount(account);
    state.accountTextMode = "created";
    state.challenge = null;
    showMessenger(account);
  } catch (error) {
    setMessage("profile", translatedServerMessage(error.message, "errAccountCreate"));
  } finally {
    setLoading(submitButton, false);
    validateProfile();
  }
}

phoneInput.addEventListener("input", normalizePhone);

phoneForm.addEventListener("submit", (event) => {
  event.preventDefault();
  openDeliveryModal(event.submitter);
});

deliveryButtons.forEach((button) => {
  button.addEventListener("click", () => {
    createChallenge(button.dataset.deliveryMethod, button);
  });
});

codeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  verifyChallenge(event.submitter);
});

profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createAccount(event.submitter);
});

codeInputs.forEach((input, index) => {
  input.addEventListener("input", () => {
    setCodeState("idle");
    input.value = digitsOnly(input.value).slice(0, 1);
    codeButton.disabled = readCode().length !== 6;
    if (input.value && index < codeInputs.length - 1) {
      codeInputs[index + 1].focus();
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Backspace" && !input.value && index > 0) {
      codeInputs[index - 1].focus();
    }
  });

  input.addEventListener("paste", (event) => {
    event.preventDefault();
    fillCode(event.clipboardData.getData("text"));
  });
});

profileForm.addEventListener("input", (event) => {
  if (event.target.name === "displayName" && !profileForm.elements.username.value.trim()) {
    profileForm.elements.username.value = suggestUsername(event.target.value);
  }

  if (event.target.name === "username") {
    normalizeUsernameInput(event.target);
  }

  if (event.target.name === "displayName" && !state.avatarDataUrl && avatarInitial) {
    avatarInitial.textContent = getProfileInitial();
  }

  validateProfile();
});

document.querySelectorAll('[data-action="choose-avatar"]').forEach((button) => {
  button.addEventListener("click", () => {
    avatarInput?.click();
  });
});

avatarInput?.addEventListener("change", async () => {
  const file = avatarInput.files?.[0];
  if (!file) {
    return;
  }

  try {
    setAvatarData(await readAvatarFile(file));
    setMessage("profile", "");
  } catch (error) {
    setMessage("profile", translatedServerMessage(error.message, "errAvatar"));
  }
});

document.querySelectorAll('[data-action="back-phone"]').forEach((button) => {
  button.addEventListener("click", () => {
    setScreen("phone", { focusPhone: true });
  });
});

document.querySelectorAll('[data-action="back-home"]').forEach((button) => {
  button.addEventListener("click", backHome);
});

document.querySelector('[data-action="resend-code"]').addEventListener("click", (event) => {
  state.deliveryActionButton = event.currentTarget;
  createChallenge(state.verificationDeliveryMethod, event.currentTarget);
});

document.querySelector('[data-action="open-qr"]').addEventListener("click", () => setScreen("qr"));

document.querySelector('[data-action="toggle-theme"]').addEventListener("click", () => {
  setTheme(nextTheme(state.theme));
});

document.querySelectorAll("[data-info-page]").forEach((button) => {
  button.addEventListener("click", () => {
    openStandalonePage(button.dataset.infoPage);
  });
});

document.querySelector('[data-action="open-language"]')?.addEventListener("click", () => setScreen("language"));
document.querySelector('[data-action="open-language-choice"]')?.addEventListener("click", (event) => {
  event.preventDefault();
  openLanguageChoice();
});
document.querySelector('[data-action="open-help"]').addEventListener("click", () => openStandalonePage("help"));
document.querySelector('[data-action="open-country"]').addEventListener("click", (event) => {
  event.preventDefault();
  openCountryChoice();
});

document.querySelectorAll('[data-action="select-country"]').forEach((button) => {
  button.addEventListener("click", () => {
    setCountry(button.dataset.country, button.dataset.countryCode);
    phoneInput.value = "";
    normalizePhone();
    closeCountryChoice();
    setScreen("phone", { focusPhone: true });
  });
});

countrySearch?.addEventListener("input", renderCountryChoice);
countrySearch?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
  }
});

countryList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-country]");
  if (!button) {
    return;
  }

  setCountry(button.dataset.country);
  phoneInput.value = "";
  normalizePhone();
  closeCountryChoice();
  phoneInput.focus();
});

document.addEventListener("click", (event) => {
  if (!countryChoice || countryChoice.hidden) {
    return;
  }

  if (event.target.closest("[data-country-choice]") || event.target.closest('[data-action="open-country"]')) {
    return;
  }

  closeCountryChoice();
});

document.addEventListener("click", (event) => {
  if (!languageChoice || languageChoice.hidden) {
    return;
  }

  if (event.target.closest("[data-language-choice]") || event.target.closest('[data-action="open-language-choice"]')) {
    return;
  }

  closeLanguageChoice();
});

document.querySelectorAll("[data-language]").forEach((button) => {
  button.addEventListener("click", () => {
    setLanguage(button.dataset.language);
    closeLanguageChoice();
  });
});

chatSearch?.addEventListener("input", refreshChatSearch);

chatList?.addEventListener("click", (event) => {
  const searchUserRow = event.target.closest("[data-search-user-id]");
  if (searchUserRow) {
    openPrivateChatFromSearch(searchUserRow.dataset.searchUserId).catch(() => {});
    return;
  }

  const row = event.target.closest("[data-chat-id]");
  if (!row) {
    return;
  }

  selectChat(row.dataset.chatId).catch(() => {});
});

messageList?.addEventListener("click", (event) => {
  const bubble = event.target.closest("[data-message-id]");
  if (!bubble) {
    return;
  }

  if (state.ignoreNextMessageClick) {
    state.ignoreNextMessageClick = false;
    return;
  }

  const messageId = bubble.dataset.messageId;
  if (state.selectingMessages) {
    toggleSelectedMessage(messageId);
    return;
  }

  openMessageMenu(messageId, event.clientX, event.clientY);
});

messageList?.addEventListener("contextmenu", (event) => {
  const bubble = event.target.closest("[data-message-id]");
  if (!bubble) {
    return;
  }

  event.preventDefault();
  openMessageMenu(bubble.dataset.messageId, event.clientX, event.clientY);
});

messageList?.addEventListener("pointerdown", (event) => {
  const bubble = event.target.closest("[data-message-id]");
  if (!bubble || event.pointerType === "mouse") {
    return;
  }

  window.clearTimeout(state.messagePressTimer);
  state.messagePressTimer = window.setTimeout(() => {
    state.ignoreNextMessageClick = true;
    openMessageMenu(bubble.dataset.messageId, event.clientX, event.clientY);
  }, 520);
});

["pointerup", "pointercancel", "pointerleave"].forEach((eventName) => {
  messageList?.addEventListener(eventName, () => {
    window.clearTimeout(state.messagePressTimer);
    state.messagePressTimer = null;
  });
});

messageInput?.addEventListener("input", () => {
  const chat = getActiveChat();
  sendButton.disabled = chat?.canSend === false || (!messageInput.value.trim() && state.pendingAttachments.length === 0);
});

composerContext?.addEventListener("click", (event) => {
  if (!event.target.closest('[data-action="cancel-message-mode"]')) {
    return;
  }

  if (state.editingMessageId && messageInput) {
    messageInput.value = "";
  }
  resetComposerMode();
  renderAttachmentTray();
});

document.addEventListener("click", (event) => {
  const actionButton = event.target.closest("[data-message-action]");
  if (actionButton) {
    handleMessageAction(actionButton.dataset.messageAction);
    return;
  }

  if (event.target.closest("[data-message-menu]") || event.target.closest("[data-message-id]")) {
    return;
  }

  closeMessageMenu();
});

document.addEventListener("click", (event) => {
  const chatButton = event.target.closest("[data-forward-chat]");
  if (chatButton) {
    forwardMessageTo(chatButton.dataset.forwardChat).catch((error) => {
      alert(translatedServerMessage(error.message, "errSendMessage"));
    });
    return;
  }

  if (event.target.closest("[data-forward-close]")) {
    closeForwardPicker();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }

  closeMessageMenu();
  closeForwardPicker();
  if (state.selectingMessages) {
    clearMessageSelection();
  }
});

attachmentButton?.addEventListener("click", () => {
  if (getActiveChat()?.canSend === false) {
    return;
  }

  attachmentInput?.click();
});

stickersButton?.addEventListener("click", () => {
  if (getActiveChat()?.canSend === false) {
    return;
  }

  alert(t("stickersSoon"));
});

attachmentInput?.addEventListener("change", () => {
  addAttachments(attachmentInput.files);
});

attachmentTray?.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-remove-attachment]");
  if (!removeButton) {
    return;
  }

  state.pendingAttachments = state.pendingAttachments.filter((item) => item.id !== removeButton.dataset.removeAttachment);
  renderAttachmentTray();
});

messageForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const chat = getActiveChat();
  const text = messageInput.value.trim();

  if (!chat || chat.canSend === false || (!text && state.pendingAttachments.length === 0 && !state.editingMessageId)) {
    return;
  }

  sendButton.disabled = true;

  try {
    const targetChat = state.editingMessageId ? chat : await ensureRealChatForMessage(chat);
    const result = state.editingMessageId && yachatApi.messenger.updateMessage
      ? await yachatApi.messenger.updateMessage({
          chatId: chat.id,
          messageId: state.editingMessageId,
          text
        })
      : await yachatApi.messenger.send({
          chatId: targetChat.id,
          text,
          attachments: state.pendingAttachments,
          replyToMessageId: state.replyToMessage?.messageId || null
        });
    messageInput.value = "";
    state.pendingAttachments = [];
    state.editingMessageId = null;
    state.replyToMessage = null;
    renderAttachmentTray();
    renderComposerContext();
    state.chats = result.chats || await yachatApi.messenger.chats();
    state.messages = result.messages || await yachatApi.messenger.messages(targetChat.id);
    renderChatList();
    renderActiveChat();
    renderMessages();
  } catch (error) {
    alert(translatedServerMessage(error.message, "errSendMessage"));
  } finally {
    sendButton.disabled = getActiveChat()?.canSend === false || (!messageInput.value.trim() && state.pendingAttachments.length === 0);
  }
});

document.querySelector('[data-action="new-chat"]')?.addEventListener("click", () => {
  openCreateChat();
});

document.querySelector('[data-action="chat-card"]')?.addEventListener("click", () => {
  openPanel("chat");
});

document.querySelector('[data-action="dialog-back"]')?.addEventListener("click", () => {
  closePanel();
  setMobileDialogOpen(false);
});

document.querySelectorAll("[data-rail]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-rail]").forEach((item) => {
      item.classList.toggle("is-active", item === button);
    });

    if (button.dataset.rail === "all") {
      closePanel();
      setMobileDialogOpen(false);
      return;
    }

    openPanel(button.dataset.rail);
  });
});

document.querySelector('[data-action="close-panel"]')?.addEventListener("click", closePanel);

panelBody?.addEventListener("input", (event) => {
  const profileUsernameInput = event.target.closest("[data-profile-username]");
  if (profileUsernameInput) {
    normalizeUsernameInput(profileUsernameInput);
    state.profileEditMessage = "";
  }
});

panelBody?.addEventListener("click", async (event) => {
  const chatButton = event.target.closest("[data-panel-chat]");
  if (chatButton) {
    closePanel();
    await selectChat(chatButton.dataset.panelChat);
    return;
  }

  const contactButton = event.target.closest("[data-contact-user-id]");
  if (contactButton) {
    await openPrivateChatWithContact(contactButton.dataset.contactUserId, contactButton);
    return;
  }

  const actionButton = event.target.closest("[data-panel-action]");
  if (!actionButton) {
    return;
  }

  const action = actionButton.dataset.panelAction;
  if (action === "edit-profile") {
    openProfileEditor();
    return;
  }

  if (action === "cancel-profile-edit") {
    closeProfileEditor();
    return;
  }

  if (action === "pick-profile-avatar") {
    panelBody.querySelector("[data-profile-avatar-input]")?.click();
    return;
  }

  if (action === "remove-profile-avatar") {
    state.profileEditAvatarDataUrl = "";
    renderPanel();
    return;
  }

  if (action === "save-profile") {
    saveProfileFromPanel(actionButton);
    return;
  }

  if (action === "toggle-theme") {
    setTheme(nextTheme(state.theme));
    return;
  }

  if (action === "scan-session") {
    startQrScanner();
    return;
  }

  if (action === "request-contacts") {
    importDeviceContacts(actionButton);
    return;
  }

  if (action === "check-contact-input") {
    checkManualContacts(actionButton);
    return;
  }

  if (action === "logout") {
    logoutAccount();
    return;
  }

  if (action === "delete-profile") {
    openDeleteProfileConfirm(actionButton);
    return;
  }

  if (action === "open-policy") {
    openStandalonePage("policy");
    return;
  }

  if (action === "open-terms") {
    openStandalonePage("terms");
    return;
  }

  if (action === "pick-chat-avatar") {
    panelBody.querySelector("[data-chat-avatar-input]")?.click();
    return;
  }

  if (action === "remove-chat-avatar") {
    state.pendingChatAvatarDataUrl = "";
    renderPanel();
    return;
  }

  if (action === "save-chat") {
    saveActiveChat(actionButton);
    return;
  }

  if (action === "invite-chat") {
    inviteActiveChat(actionButton);
    return;
  }

  if (action === "copy-invite") {
    copyActiveInvite();
    return;
  }

  if (action === "leave-chat") {
    leaveActiveChat(actionButton);
  }
});

panelBody?.addEventListener("change", async (event) => {
  const sessionCapture = event.target.closest("[data-session-capture]");
  if (sessionCapture) {
    await scanCapturedSessionImage(sessionCapture.files?.[0]);
    sessionCapture.value = "";
    return;
  }

  const profileAvatarInput = event.target.closest("[data-profile-avatar-input]");
  if (profileAvatarInput) {
    const file = profileAvatarInput.files?.[0];
    if (!file) {
      return;
    }

    try {
      state.profileEditAvatarDataUrl = await readAvatarFile(file);
      state.profileEditMessage = "";
      renderPanel();
    } catch (error) {
      state.profileEditMessage = translatedServerMessage(error.message, "errAvatar");
      renderPanel();
    } finally {
      profileAvatarInput.value = "";
    }
    return;
  }

  const input = event.target.closest("[data-chat-avatar-input]");
  if (!input) {
    return;
  }

  const file = input.files?.[0];
  if (!file) {
    return;
  }

  try {
    state.pendingChatAvatarDataUrl = await readAvatarFile(file);
    renderPanel();
  } catch (error) {
    alert(error.message || t("errAvatar"));
  }
});

createChatForm?.querySelectorAll("[data-chat-kind]").forEach((button) => {
  button.addEventListener("click", () => {
    state.newChatKind = button.dataset.chatKind === "group" ? "group" : "private";
    state.createChatSelectedIds = state.newChatKind === "private"
      ? state.createChatSelectedIds.slice(0, 1)
      : state.createChatSelectedIds;
    setMessage("create-chat", "");
    renderCreateChatForm();
  });
});

createChatForm?.addEventListener("input", (event) => {
  if (event.target.matches("[data-create-people-search], [name='title']")) {
    renderCreateChatForm();
  }
});

createChatForm?.addEventListener("click", (event) => {
  const avatarButton = event.target.closest('[data-action="choose-create-chat-avatar"]');
  if (avatarButton) {
    createChatForm.querySelector("[data-create-chat-avatar-input]")?.click();
    return;
  }

  const userButton = event.target.closest("[data-create-user-id]");
  if (userButton) {
    const id = userButton.dataset.createUserId;
    state.createChatSelectedIds = state.newChatKind === "private"
      ? [id]
      : [...new Set([...state.createChatSelectedIds, id])];
    createChatForm.elements.peopleSearch.value = "";
    setMessage("create-chat", "");
    renderCreateChatForm();
    return;
  }

  const removeButton = event.target.closest("[data-remove-create-user]");
  if (removeButton) {
    state.createChatSelectedIds = state.createChatSelectedIds.filter((id) => id !== removeButton.dataset.removeCreateUser);
    renderCreateChatForm();
  }
});

createChatForm?.querySelector("[data-create-chat-avatar-input]")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    state.pendingCreateChatAvatarDataUrl = await readAvatarFile(file);
    renderCreateChatForm();
  } catch (error) {
    alert(error.message || t("errAvatar"));
  } finally {
    event.target.value = "";
  }
});

createChatForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  createChatFromForm(event.submitter);
});

document.querySelector('[data-action="close-create-chat"]')?.addEventListener("click", closeCreateChat);

createChatModal?.addEventListener("click", (event) => {
  if (event.target === createChatModal) {
    closeCreateChat();
  }
});

document.querySelectorAll('[data-action="close-delivery"]').forEach((button) => {
  button.addEventListener("click", () => closeDeliveryModal());
});

deleteProfileForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitDeleteProfileConfirm();
});

document.querySelectorAll('[data-action="close-delete-profile"]').forEach((button) => {
  button.addEventListener("click", closeDeleteProfileConfirm);
});

deleteProfileModal?.addEventListener("click", (event) => {
  if (event.target === deleteProfileModal) {
    closeDeleteProfileConfirm();
  }
});

document.querySelector('[data-action="refresh-qr"]')?.addEventListener("click", startQrLogin);

document.querySelector('[data-action="view-account"]').addEventListener("click", () => {
  if (!state.account) {
    return;
  }

  const createdAt = new Date(state.account.createdAt).toLocaleString(state.language === "en" ? "en-US" : "ru-RU");
  alert(t("alertAccount", {
    name: state.account.displayName,
    username: state.account.username,
    bio: state.account.bio || "—",
    contact: state.account.contact,
    createdAt
  }));
});

yachatApi.account.get().then((account) => {
  if (!account) {
    return;
  }

  state.account = normalizeAccount(account);
  state.accountTextMode = "existing";
  showMessenger(account);
}).catch(() => {});

if (systemThemeQuery?.addEventListener) {
  systemThemeQuery.addEventListener("change", syncSystemTheme);
} else if (systemThemeQuery?.addListener) {
  systemThemeQuery.addListener(syncSystemTheme);
}

setTheme(state.theme, false, state.themeSource);
setDeliveryMethod(state.verificationDeliveryMethod);
applyTranslations();
loadServerState();
normalizePhone();
validateProfile();

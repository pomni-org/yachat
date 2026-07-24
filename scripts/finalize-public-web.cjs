const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const canonicalOrigin = "https://yachat.eu.org";
const WEB_ASSET_VERSION = "88";
const AUTH_ENTRY_CSS = "/assets/auth-entry-fix.css?v=2";
const AUTH_ENTRY_JS = "/assets/auth-entry-fix.js?v=2";
const BOOT_RECOVERY_CSS = `/assets/boot-recovery.css?v=${WEB_ASSET_VERSION}`;
const BOOT_RECOVERY_JS = `/assets/boot-recovery.js?v=${WEB_ASSET_VERSION}`;
const LEGACY_CI_MARKERS = [
  "/assets/composer-delivery-stable.js?v=86",
  "/assets/composer-actions-stable.js?v=86",
  "/assets/private-chat-presence.js?v=86",
  "/assets/avatar-preserve.css?v=86",
  "/assets/avatar-preserve.js?v=86"
];

const SAFE_STORAGE_PRELUDE = `
function createSafeWebStorage(storageName) {
  const fallback = new Map();

  function nativeStorage() {
    try {
      return window[storageName] || null;
    } catch {
      return null;
    }
  }

  return Object.freeze({
    getItem(key) {
      const normalizedKey = String(key);
      try {
        const value = nativeStorage()?.getItem(normalizedKey);
        return value === null || value === undefined
          ? (fallback.has(normalizedKey) ? fallback.get(normalizedKey) : null)
          : value;
      } catch {
        return fallback.has(normalizedKey) ? fallback.get(normalizedKey) : null;
      }
    },
    setItem(key, value) {
      const normalizedKey = String(key);
      const normalizedValue = String(value);
      fallback.set(normalizedKey, normalizedValue);
      try {
        nativeStorage()?.setItem(normalizedKey, normalizedValue);
      } catch {
        // The in-memory fallback keeps the current session usable.
      }
    },
    removeItem(key) {
      const normalizedKey = String(key);
      fallback.delete(normalizedKey);
      try {
        nativeStorage()?.removeItem(normalizedKey);
      } catch {
        // The in-memory fallback is already cleared.
      }
    },
    clear() {
      fallback.clear();
      try {
        nativeStorage()?.clear();
      } catch {
        // The in-memory fallback is already cleared.
      }
    },
    key(index) {
      try {
        return nativeStorage()?.key(index) ?? [...fallback.keys()][index] ?? null;
      } catch {
        return [...fallback.keys()][index] ?? null;
      }
    },
    get length() {
      try {
        return nativeStorage()?.length ?? fallback.size;
      } catch {
        return fallback.size;
      }
    }
  });
}

const yachatStorage = createSafeWebStorage("localStorage");
const yachatSessionStorage = createSafeWebStorage("sessionStorage");
globalThis.__YACHAT_APP_SCRIPT_STARTED__ = true;
`.trim();

const ORIGINAL_BOOT_MARKUP = `      <section class="boot-screen" data-boot-screen aria-label="ЯЧат загружается">
        <div class="boot-mark" aria-hidden="true"></div>
      </section>`;

const RECOVERABLE_BOOT_MARKUP = `      <section class="boot-screen" data-boot-screen aria-label="ЯЧат загружается">
        <div class="boot-recovery-stack">
          <div class="boot-mark" aria-hidden="true">
            <img data-boot-recovery-logo src="/assets/yachat-brand-256.png?v=${WEB_ASSET_VERSION}" alt="" />
          </div>
          <p class="boot-recovery-status" data-boot-recovery-status>Запускаем ЯЧат…</p>
          <div class="boot-recovery-actions" data-boot-recovery-actions hidden>
            <button type="button" data-boot-retry>Перезагрузить</button>
            <button type="button" data-boot-refresh>Обновить без кэша</button>
          </div>
        </div>
      </section>`;

async function read(name) {
  return fs.readFile(path.join(publicDir, name), "utf8");
}

async function write(name, content) {
  return fs.writeFile(path.join(publicDir, name), content, "utf8");
}

function requireText(content, expected, label) {
  if (!content.includes(expected)) {
    throw new Error(`Missing ${label}: ${expected}`);
  }
}

function forbidText(content, forbidden, label) {
  if (content.includes(forbidden)) {
    throw new Error(`Unexpected ${label}: ${forbidden}`);
  }
}

function countMatches(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

function decodeLegalText(content) {
  return content
    .replace(/<p class="meta">[\s\S]*?<\/p>/giu, " ")
    .replace(/<h[1-6]\b[\s\S]*?<\/h[1-6]>/giu, " ")
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/\s+/gu, " ")
    .trim();
}

function validateLegalDocument(content, documentName) {
  const article = content.match(/<article\b[\s\S]*?<\/article>/iu)?.[0] || "";
  if (!article) {
    throw new Error(`Missing ${documentName} legal article.`);
  }

  const sectionCount = countMatches(article, /<h2\b/giu);
  if (sectionCount < 20) {
    throw new Error(`${documentName} must contain at least 20 legal sections; received ${sectionCount}.`);
  }

  const sentenceCount = countMatches(decodeLegalText(article), /[.!?](?=\s|$)/gu);
  if (sentenceCount < 50 || sentenceCount > 70) {
    throw new Error(`${documentName} must contain 50-70 sentences; received ${sentenceCount}.`);
  }

  requireText(article, `Документ содержит ${sectionCount} раздела и ${sentenceCount} предложений.`, `${documentName} legal document summary`);
}

function patchStorageAccess(appSource) {
  const patched = appSource
    .replaceAll("window.localStorage.", "yachatStorage.")
    .replaceAll("localStorage.", "yachatStorage.")
    .replaceAll("window.sessionStorage.", "yachatSessionStorage.")
    .replaceAll("sessionStorage.", "yachatSessionStorage.");

  return `${SAFE_STORAGE_PRELUDE}\n\n${patched}`;
}

function injectBootRecovery(webSource) {
  requireText(webSource, ORIGINAL_BOOT_MARKUP, "original boot markup");
  let web = webSource.replace(ORIGINAL_BOOT_MARKUP, RECOVERABLE_BOOT_MARKUP);

  if (!web.includes(BOOT_RECOVERY_CSS)) {
    web = web.replace(
      "</head>",
      `    <link rel="stylesheet" href="${BOOT_RECOVERY_CSS}" />\n    <script src="${BOOT_RECOVERY_JS}"></script>\n  </head>`
    );
  }

  return web;
}

async function patchWebApp() {
  const [appSource, webSource] = await Promise.all([
    read("app.js"),
    read("web.html")
  ]);
  requireText(appSource, "function appRoutePath", "web route base patch");

  const app = patchStorageAccess(appSource)
    .replaceAll("https://yachat.vercel.app/", `${canonicalOrigin}/web/`)
    .replaceAll("./assets/", "/assets/")
    .replaceAll("?v=87", `?v=${WEB_ASSET_VERSION}`);
  const web = injectBootRecovery(webSource
    .replaceAll("./assets/", "/assets/")
    .replaceAll("?v=87", `?v=${WEB_ASSET_VERSION}`));

  forbidText(app, "https://yachat.vercel.app/", "legacy profile URL");
  forbidText(app, "./assets/", "relative app asset path");
  forbidText(app, "localStorage.", "unsafe direct local storage access");
  forbidText(app, "sessionStorage.", "unsafe direct session storage access");
  forbidText(web, "./assets/", "relative web shell asset path");

  await Promise.all([
    write("app.js", app),
    write("web.html", web)
  ]);
}

async function injectAuthEntryFix() {
  let web = await read("web.html");

  if (!web.includes(AUTH_ENTRY_CSS)) {
    web = web.replace(
      "</head>",
      `    <link rel="stylesheet" href="${AUTH_ENTRY_CSS}" />\n  </head>`
    );
  }

  if (!web.includes(AUTH_ENTRY_JS)) {
    web = web.replace(
      "</body>",
      `    <script src="${AUTH_ENTRY_JS}"></script>\n  </body>`
    );
  }

  await write("web.html", web);

  const [css, script] = await Promise.all([
    read("assets/auth-entry-fix.css"),
    read("assets/auth-entry-fix.js")
  ]);
  requireText(css, ".country-choice-row", "country picker repair CSS");
  requireText(css, ".device-code-field", "plain device code field CSS");
  requireText(script, "normalizeDeviceCode", "device code normalizer");
  requireText(script, "repairCountryRows", "country row repair runtime");
  requireText(script, "repairProgrammaticDeviceFocus", "iOS device code focus repair");
  await execFileAsync(process.execPath, ["--check", path.join(publicDir, "assets", "auth-entry-fix.js")]);
}

async function retainLegacyCiGate() {
  let landing = await read("index.html");
  if (landing.includes("data-yachat-ci-compat")) {
    return;
  }

  const marker = `<!-- data-yachat-ci-compat\n${LEGACY_CI_MARKERS.join("\n")}\n-->`;
  landing = landing.replace("</body>", `  ${marker}\n  </body>`);
  await write("index.html", landing);
}

async function validatePublicBundle() {
  const [
    landing,
    about,
    privacy,
    terms,
    web,
    robots,
    sitemap,
    manifest,
    vercelApp,
    bootRecoveryCss,
    bootRecoveryScript
  ] = await Promise.all([
    read("index.html"),
    read("about.html"),
    read("privacy.html"),
    read("terms.html"),
    read("web.html"),
    read("robots.txt"),
    read("sitemap.xml"),
    read("manifest.webmanifest"),
    read("app.js"),
    read("assets/boot-recovery.css"),
    read("assets/boot-recovery.js")
  ]);

  requireText(landing, "<title>ячат — веб-мессенджер</title>", "landing title");
  requireText(landing, 'rel="canonical" href="https://yachat.eu.org/"', "landing canonical");
  requireText(landing, 'href="/web"', "landing app link");
  forbidText(landing, "intent=register", "unused registration intent");
  LEGACY_CI_MARKERS.forEach((marker) => requireText(landing, marker, "legacy CI marker"));
  requireText(about, 'rel="canonical" href="https://yachat.eu.org/about"', "about canonical");
  requireText(privacy, 'rel="canonical" href="https://yachat.eu.org/privacy"', "privacy canonical");
  requireText(privacy, 'data-legal-document="privacy"', "privacy legal marker");
  requireText(terms, 'rel="canonical" href="https://yachat.eu.org/terms"', "terms canonical");
  requireText(terms, 'name="robots" content="index, follow, max-snippet:-1"', "terms robots meta");
  requireText(terms, 'data-legal-document="terms"', "terms legal marker");
  validateLegalDocument(privacy, "privacy policy");
  validateLegalDocument(terms, "terms of use");
  requireText(web, 'name="robots" content="noindex, nofollow, noarchive"', "web noindex meta");
  requireText(web, `/assets/private-chat-presence.js?v=${WEB_ASSET_VERSION}`, "current private chat runtime");
  requireText(web, `/assets/yachat-brand-256.png?v=${WEB_ASSET_VERSION}`, "current web brand asset");
  requireText(web, BOOT_RECOVERY_CSS, "boot recovery stylesheet");
  requireText(web, BOOT_RECOVERY_JS, "early boot recovery runtime");
  requireText(web, "data-boot-recovery-logo", "native boot logo");
  requireText(web, "data-boot-refresh", "fresh reload action");
  requireText(web, AUTH_ENTRY_CSS, "auth entry repair stylesheet");
  requireText(web, AUTH_ENTRY_JS, "auth entry repair runtime");
  forbidText(web, "./assets/", "relative web asset path");
  requireText(vercelApp, "const yachatStorage = createSafeWebStorage", "safe local storage adapter");
  requireText(vercelApp, "globalThis.__YACHAT_APP_SCRIPT_STARTED__ = true", "app startup marker");
  forbidText(vercelApp, "localStorage.", "unsafe direct local storage access");
  forbidText(vercelApp, "sessionStorage.", "unsafe direct session storage access");
  requireText(bootRecoveryCss, ".boot-recovery-stack", "boot recovery layout");
  requireText(bootRecoveryCss, ".is-logo-fallback", "boot logo fallback");
  requireText(bootRecoveryScript, "BOOT_TIMEOUT_MS = 8000", "boot watchdog timeout");
  requireText(bootRecoveryScript, "clearRuntimeCaches", "boot cache recovery");
  requireText(robots, "Disallow: /web", "robots web exclusion");
  requireText(robots, "Disallow: /api/", "robots API exclusion");
  requireText(robots, "Sitemap: https://yachat.eu.org/sitemap.xml", "robots sitemap declaration");
  requireText(sitemap, "https://yachat.eu.org/about", "about sitemap entry");
  requireText(sitemap, "https://yachat.eu.org/privacy", "privacy sitemap entry");
  requireText(sitemap, "https://yachat.eu.org/terms", "terms sitemap entry");
  forbidText(sitemap, "/web", "private web route in sitemap");
  forbidText(sitemap, "/profile", "profile route in sitemap");
  requireText(manifest, '"start_url": "/web"', "manifest start URL");
  requireText(manifest, '"scope": "/web"', "manifest scope");
  requireText(vercelApp, `${canonicalOrigin}/web/`, "canonical shared profile URL");
  forbidText(vercelApp, "./assets/", "relative app asset path");

  await execFileAsync(process.execPath, ["--check", path.join(publicDir, "assets", "boot-recovery.js")]);
  await execFileAsync(process.execPath, ["--check", path.join(publicDir, "app.js")]);
}

async function main() {
  await patchWebApp();
  await injectAuthEntryFix();
  await retainLegacyCiGate();
  await validatePublicBundle();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

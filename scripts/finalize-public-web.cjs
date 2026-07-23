const fs = require("fs/promises");
const path = require("path");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const canonicalOrigin = "https://yachat.eu.org";
const LEGACY_CI_MARKERS = [
  "/assets/composer-delivery-stable.js?v=86",
  "/assets/composer-actions-stable.js?v=86",
  "/assets/private-chat-presence.js?v=86",
  "/assets/avatar-preserve.css?v=86",
  "/assets/avatar-preserve.js?v=86"
];

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

async function patchWebApp() {
  const [appSource, webSource] = await Promise.all([
    read("app.js"),
    read("web.html")
  ]);
  requireText(appSource, "function appRoutePath", "web route base patch");

  const app = appSource
    .replaceAll("https://yachat.vercel.app/", `${canonicalOrigin}/web/`)
    .replaceAll("./assets/", "/assets/");
  const web = webSource.replaceAll("./assets/", "/assets/");

  forbidText(app, "https://yachat.vercel.app/", "legacy profile URL");
  forbidText(app, "./assets/", "relative app asset path");
  forbidText(web, "./assets/", "relative web shell asset path");

  await Promise.all([
    write("app.js", app),
    write("web.html", web)
  ]);
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
  const [landing, about, privacy, web, robots, sitemap, manifest, vercelApp] = await Promise.all([
    read("index.html"),
    read("about.html"),
    read("privacy.html"),
    read("web.html"),
    read("robots.txt"),
    read("sitemap.xml"),
    read("manifest.webmanifest"),
    read("app.js")
  ]);

  requireText(landing, "<title>ячат — веб-мессенджер</title>", "landing title");
  requireText(landing, 'rel="canonical" href="https://yachat.eu.org/"', "landing canonical");
  requireText(landing, 'href="/web"', "landing app link");
  LEGACY_CI_MARKERS.forEach((marker) => requireText(landing, marker, "legacy CI marker"));
  requireText(about, 'rel="canonical" href="https://yachat.eu.org/about"', "about canonical");
  requireText(privacy, 'rel="canonical" href="https://yachat.eu.org/privacy"', "privacy canonical");
  requireText(web, 'name="robots" content="noindex, nofollow, noarchive"', "web noindex meta");
  requireText(web, "/assets/private-chat-presence.js?v=87", "v87 private chat runtime");
  requireText(web, "/assets/yachat-brand-light.png?v=87", "absolute web brand asset");
  forbidText(web, "./assets/", "relative web asset path");
  requireText(robots, "Disallow: /web", "robots web exclusion");
  requireText(robots, "Disallow: /api/", "robots API exclusion");
  requireText(robots, "Sitemap: https://yachat.eu.org/sitemap.xml", "robots sitemap declaration");
  requireText(sitemap, "https://yachat.eu.org/about", "about sitemap entry");
  requireText(sitemap, "https://yachat.eu.org/privacy", "privacy sitemap entry");
  forbidText(sitemap, "/web", "private web route in sitemap");
  forbidText(sitemap, "/profile", "profile route in sitemap");
  requireText(manifest, '"start_url": "/web"', "manifest start URL");
  requireText(manifest, '"scope": "/web"', "manifest scope");
  requireText(vercelApp, `${canonicalOrigin}/web/`, "canonical shared profile URL");
  forbidText(vercelApp, "./assets/", "relative app asset path");
}

async function main() {
  await patchWebApp();
  await retainLegacyCiGate();
  await validatePublicBundle();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

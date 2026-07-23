import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const executablePath = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pageErrors = [];
const consoleErrors = [];

page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

await page.setContent(`<!doctype html>
<html>
  <head>
    <style>
      :root {
        --page: #0d001a;
        --surface: #2d2238;
        --text: #fff;
        --card-edge: rgba(255, 255, 255, .12);
      }
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      .messenger-shell { position: fixed; inset: 0; }
      .messenger-rail {
        position: fixed;
        z-index: 2;
        right: 0;
        bottom: 0;
        left: 0;
        height: 68px;
        background: #160826;
      }
      .side-panel {
        position: fixed;
        z-index: 3;
        overflow: hidden;
        background: var(--page);
      }
      .side-panel-body { width: 100%; height: 100%; overflow: auto; }
      .lucide-icon { display: block; width: 100%; height: 100%; }
    </style>
  </head>
  <body class="messenger-mode">
    <section class="messenger-shell">
      <aside class="messenger-rail" aria-label="Навигация"></aside>
      <aside class="side-panel is-settings-redesign">
        <header class="side-panel-head"></header>
        <div class="side-panel-body is-settings-redesign-body"></div>
      </aside>
    </section>
  </body>
</html>`);

await page.addStyleTag({ path: "src/renderer/assets/settings-redesign.css" });
await page.addStyleTag({ path: "src/renderer/assets/settings-detail-layout.css" });

await page.evaluate(() => {
  globalThis.state = {
    activePanel: "settings",
    settingsPage: ""
  };
  globalThis.sidePanel = document.querySelector(".side-panel");
  globalThis.panelBody = document.querySelector(".side-panel-body");
  globalThis.iconSvg = () => '<svg class="lucide-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>';

  globalThis.renderPanel = function renderFixturePanel() {
    panelBody.innerHTML = state.settingsPage
      ? `<header class="settings-detail-head">
          <button type="button" data-settings-action="back" aria-label="Назад">${iconSvg()}</button>
          <h2>Цифровой ID</h2>
        </header>
        <main class="settings-card">detail</main>`
      : '<main data-settings-home>settings home</main>';
  };

  globalThis.closePanel = function closeFixturePanel() {
    state.activePanel = null;
    sidePanel.hidden = true;
  };

  document.addEventListener("click", (event) => {
    if (!event.target.closest('[data-settings-action="back"]')) return;
    state.settingsPage = "";
    renderPanel();
  });
});

await page.addScriptTag({ path: "src/renderer/assets/settings-detail-navigation.js" });
await page.evaluate(() => renderPanel());

const home = await page.evaluate(() => {
  const rail = document.querySelector(".messenger-rail");
  const panel = document.querySelector(".side-panel");
  const panelStyle = getComputedStyle(panel);
  return {
    detailClass: document.body.classList.contains("settings-detail-open"),
    navDisplay: getComputedStyle(rail).display,
    panelBottom: Number.parseFloat(panelStyle.bottom),
    homeVisible: Boolean(document.querySelector("[data-settings-home]"))
  };
});

assert.equal(home.detailClass, false, "settings list must not use detail mode");
assert.notEqual(home.navDisplay, "none", "navigation must remain visible on settings list");
assert.ok(home.panelBottom >= 68, `settings list must reserve navigation height, got ${home.panelBottom}`);
assert.equal(home.homeVisible, true);

await page.evaluate(() => {
  state.settingsPage = "digital-id";
  renderPanel();
});

const detail = await page.evaluate(() => {
  const rail = document.querySelector(".messenger-rail");
  const panel = document.querySelector(".side-panel");
  const header = document.querySelector(".settings-detail-head");
  const button = header.querySelector("button");
  const title = header.querySelector("h2");
  const panelRect = panel.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  const titleRect = title.getBoundingClientRect();
  return {
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    detailClass: document.body.classList.contains("settings-detail-open"),
    navDisplay: getComputedStyle(rail).display,
    panelRect: { top: panelRect.top, right: panelRect.right, bottom: panelRect.bottom, left: panelRect.left },
    headerRect: { top: headerRect.top, right: headerRect.right, bottom: headerRect.bottom, left: headerRect.left },
    buttonCenterY: buttonRect.top + buttonRect.height / 2,
    titleCenterX: titleRect.left + titleRect.width / 2,
    titleCenterY: titleRect.top + titleRect.height / 2,
    titleText: title.textContent.trim()
  };
});

assert.equal(detail.detailClass, true, "a concrete settings page must enable detail mode");
assert.equal(detail.navDisplay, "none", "navigation must be hidden inside a settings item");
assert.ok(Math.abs(detail.panelRect.top) <= 1, `detail panel top is ${detail.panelRect.top}`);
assert.ok(Math.abs(detail.panelRect.left) <= 1, `detail panel left is ${detail.panelRect.left}`);
assert.ok(Math.abs(detail.panelRect.right - detail.viewportWidth) <= 1, `detail panel right is ${detail.panelRect.right}`);
assert.ok(Math.abs(detail.panelRect.bottom - detail.viewportHeight) <= 1, `detail panel bottom is ${detail.panelRect.bottom}`);
assert.ok(Math.abs(detail.headerRect.left) <= 1, `detail header left edge is ${detail.headerRect.left}`);
assert.ok(Math.abs(detail.headerRect.right - detail.viewportWidth) <= 1, `detail header right edge is ${detail.headerRect.right}`);
assert.ok(Math.abs(detail.titleCenterX - detail.viewportWidth / 2) <= 1, `title center is ${detail.titleCenterX}`);
assert.ok(Math.abs(detail.buttonCenterY - detail.titleCenterY) <= 1, `button/title vertical centers differ: ${detail.buttonCenterY} vs ${detail.titleCenterY}`);
assert.equal(detail.titleText, "Цифровой ID");

await page.click('[data-settings-action="back"]');

const afterBack = await page.evaluate(() => ({
  detailClass: document.body.classList.contains("settings-detail-open"),
  navDisplay: getComputedStyle(document.querySelector(".messenger-rail")).display,
  homeVisible: Boolean(document.querySelector("[data-settings-home]"))
}));

assert.equal(afterBack.detailClass, false, "back must leave detail mode");
assert.notEqual(afterBack.navDisplay, "none", "back must restore navigation on settings list");
assert.equal(afterBack.homeVisible, true);
assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join("\n")}`);

await browser.close();
console.log("settings detail navigation suite passed");

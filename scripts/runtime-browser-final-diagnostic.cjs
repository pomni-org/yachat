const fs = require("fs");
const path = require("path");

const sourcePath = path.join(__dirname, "runtime-browser-bisect.cjs");
const generatedPath = path.join(__dirname, ".runtime-browser-settings-bisect.generated.cjs");
let source = fs.readFileSync(sourcePath, "utf8");

function replaceRequired(before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`[settings-bisect] Could not patch ${label}.`);
  }
  source = source.replace(before, after);
}

replaceRequired(
  '    unread: 0,\n    lastMessage: "Smoke message 79",',
  '    unread: 1,\n    lastMessage: "Smoke message 79",',
  "unread test data"
);

replaceRequired(
  `      if (loaded) {
        return { passed: true, prefixCount, lastState };
      }`,
  `      if (loaded) {
        try {
          const settingsButtonFound = await client.evaluate(\`(() => {
            const button = document.querySelector('[data-rail="settings"]');
            button?.click();
            return Boolean(button);
          })()\`, 1800);
          await delay(300);
          const panelVisible = await client.evaluate(
            \`document.querySelector("[data-side-panel]")?.hidden === false\`,
            1800
          );
          if (settingsButtonFound && panelVisible) {
            return { passed: true, prefixCount, lastState, settingsButtonFound, panelVisible };
          }
          return {
            passed: false,
            reason: "settings panel did not open",
            prefixCount,
            lastState,
            settingsButtonFound,
            panelVisible
          };
        } catch (error) {
          return {
            passed: false,
            reason: \`settings panel main thread unresponsive: \${error.message}\`,
            prefixCount,
            lastState,
            stderr: stderr.join("").slice(-1200)
          };
        }
      }`,
  "settings interaction criterion"
);

replaceRequired(
  "[runtime-bisect] PASS: all",
  "[browser-final] PASS SETTINGS-BISECT: all",
  "wrapper pass marker"
);

fs.writeFileSync(generatedPath, source, "utf8");
process.on("exit", () => {
  try { fs.unlinkSync(generatedPath); } catch {}
});

require(generatedPath);

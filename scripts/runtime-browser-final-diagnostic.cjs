const fs = require("fs");
const path = require("path");

const sourcePath = path.join(__dirname, "runtime-browser-final.cjs");
const generatedPath = path.join(__dirname, ".runtime-browser-final-diagnostic.generated.cjs");
let source = fs.readFileSync(sourcePath, "utf8");

function replaceRequired(before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`[browser-final-diagnostic] Could not patch ${label}.`);
  }
  source = source.replace(before, after);
}

replaceRequired(
  "  let client = null;\n  let lastState = null;\n  try {",
  "  let client = null;\n  let lastState = null;\n  let nodeStage = \"launch\";\n  try {",
  "stage state"
);
replaceRequired(
  "    const activePortFile = path.join(userDataDir, \"DevToolsActivePort\");",
  "    nodeStage = \"chrome-startup\";\n    const activePortFile = path.join(userDataDir, \"DevToolsActivePort\");",
  "Chrome startup stage"
);
replaceRequired(
  "    lastState = await waitUntilLoaded(client);",
  "    nodeStage = \"boot\";\n    lastState = await waitUntilLoaded(client);",
  "boot stage"
);
replaceRequired(
  "    const settingsButtonFound = await client.evaluate(`(() => {",
  "    nodeStage = \"settings-click\";\n    const settingsButtonFound = await client.evaluate(`(() => {",
  "settings click stage"
);
replaceRequired(
  "    const panelVisible = await client.evaluate(`document.querySelector(\"[data-side-panel]\")?.hidden === false`);",
  "    nodeStage = \"settings-panel-check\";\n    const panelVisible = await client.evaluate(`document.querySelector(\"[data-side-panel]\")?.hidden === false`);",
  "settings panel stage"
);
replaceRequired(
  "    await client.evaluate(`(() => {\n      window.__smokeStage = \"chat\";",
  "    nodeStage = \"chat-open\";\n    await client.evaluate(`(() => {\n      window.__smokeStage = \"chat\";",
  "chat stage"
);
replaceRequired(
  "    const messageMenuTriggered = await client.evaluate(`(() => {",
  "    nodeStage = \"message-menu-open\";\n    const messageMenuTriggered = await client.evaluate(`(() => {",
  "message menu open stage"
);
replaceRequired(
  "    const menuVisible = await client.evaluate(`Boolean(document.querySelector(\"[data-message-menu]:not([hidden])\"))`);",
  "    nodeStage = \"message-menu-check\";\n    const menuVisible = await client.evaluate(`Boolean(document.querySelector(\"[data-message-menu]:not([hidden])\"))`);",
  "message menu check stage"
);
replaceRequired(
  "    await client.evaluate(`window.__smokeStage = \"polling\"`);",
  "    nodeStage = \"polling-start\";\n    await client.evaluate(`window.__smokeStage = \"polling\"`);",
  "polling start stage"
);
replaceRequired(
  "    for (let index = 0; index < 7; index += 1) {\n      await delay(1000);",
  "    for (let index = 0; index < 7; index += 1) {\n      nodeStage = `polling-sample-${index + 1}`;\n      await delay(1000);",
  "polling samples"
);
replaceRequired(
  "    const metrics = await client.evaluate(`(() => {",
  "    nodeStage = \"metrics\";\n    const metrics = await client.evaluate(`(() => {",
  "metrics stage"
);
replaceRequired(
  "    throw new Error(`[browser-final] ${profile} failed: ${error.message}\\nChrome stderr:\\n${stderr.join(\"\").slice(-1800)}`);",
  "    throw new Error(`[browser-final] ${profile} failed at stage=${nodeStage}: ${error.message}; lastState=${JSON.stringify(lastState)}\\nChrome stderr:\\n${stderr.join(\"\").slice(-1800)}`);",
  "diagnostic error"
);

fs.writeFileSync(generatedPath, source, "utf8");
process.on("exit", () => {
  try { fs.unlinkSync(generatedPath); } catch {}
});

require(generatedPath);

const fs = require("fs");
const path = require("path");

const sourcePath = path.join(__dirname, "runtime-browser-final.cjs");
const generatedPath = path.join(__dirname, ".runtime-browser-final-ci.generated.cjs");
const source = fs.readFileSync(sourcePath, "utf8");
const patched = source.replace(
  "    await waitForFile(activePortFile);",
  "    await waitForFile(activePortFile, 20000);"
);

if (patched === source) {
  throw new Error("[browser-final-ci] Could not increase the Chrome startup timeout.");
}

fs.writeFileSync(generatedPath, patched, "utf8");
process.on("exit", () => {
  try { fs.unlinkSync(generatedPath); } catch {}
});

require(generatedPath);

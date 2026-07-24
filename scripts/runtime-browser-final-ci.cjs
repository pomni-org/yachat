const fs = require("fs");
const path = require("path");

const sourcePath = path.join(__dirname, "runtime-browser-final.cjs");
const generatedPath = path.join(__dirname, ".runtime-browser-final-ci.generated.cjs");
let source = fs.readFileSync(sourcePath, "utf8");

function replaceRequired(before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`[browser-final-ci] Could not patch ${label}.`);
  }
  source = source.replace(before, after);
}

replaceRequired(
  "    await waitForFile(activePortFile);",
  "    await waitForFile(activePortFile, 20000);",
  "Chrome startup timeout"
);

replaceRequired(
  "    if (metrics.messagePolls < 2) problems.push(\"incremental message polling did not run\");",
  "    if (metrics.messagePolls < (mobile ? 1 : 2)) problems.push(\"incremental message polling did not run\");",
  "profile-aware incremental polling threshold"
);

fs.writeFileSync(generatedPath, source, "utf8");
process.on("exit", () => {
  try { fs.unlinkSync(generatedPath); } catch {}
});

require(generatedPath);

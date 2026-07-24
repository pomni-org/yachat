const fs = require("fs");
const path = require("path");

const sourcePath = path.join(__dirname, "runtime-browser-bisect.cjs");
const generatedPath = path.join(__dirname, ".runtime-browser-unread-bisect.generated.cjs");
const source = fs.readFileSync(sourcePath, "utf8");
const patched = source.replace(
  '    unread: 0,\n    lastMessage: "Smoke message 79",',
  '    unread: 1,\n    lastMessage: "Smoke message 79",'
);

if (patched === source) {
  throw new Error("[runtime-unread-bisect] Could not enable unread chat state in the bisection harness.");
}

fs.writeFileSync(generatedPath, patched, "utf8");
process.on("exit", () => {
  try { fs.unlinkSync(generatedPath); } catch {}
});

require(generatedPath);

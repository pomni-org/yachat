const fs = require("fs/promises");
const path = require("path");

const root = path.resolve(__dirname, "..");
const apiPath = path.join(root, "api", "index.py");

async function main() {
  let source = await fs.readFile(apiPath, "utf8");
  const marker = '        "encrypted": True,';
  const occurrences = source.split(marker).length - 1;
  if (occurrences !== 2) {
    throw new Error(`Expected 2 legacy encrypted claims, found ${occurrences}.`);
  }

  source = source.replaceAll(
    marker,
    '        "encrypted": False,\n        "e2eePhase": "shadow",'
  );
  if (source.includes(marker) || source.split('"e2eePhase": "shadow"').length - 1 !== 2) {
    throw new Error("Unable to mark the public API as an E2EE shadow rollout.");
  }

  await fs.writeFile(apiPath, source, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

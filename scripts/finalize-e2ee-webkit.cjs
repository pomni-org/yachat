const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const runtimePath = path.join(root, "public", "assets", "e2ee-runtime.js");

async function main() {
  let runtime = await fs.readFile(runtimePath, "utf8");
  const before = `    const keys = await rawStoreGetMany("cryptoKeys", refs);
    if (keys.some((key) => !(key instanceof CryptoKey))) {
      throw new Error("One or more persisted E2EE private keys are unavailable.");
    }`;
  const after = `    const keys = await rawStoreGetMany("cryptoKeys", refs);
    keys.forEach((key) => {
      // WebKit can deserialize a valid CryptoKey with a broken prototype
      // chain. Restore the standard prototype only for CryptoKey-shaped
      // objects; the key's internal cryptographic slots remain untouched.
      if (
        !(key instanceof CryptoKey)
        && key
        && typeof key === "object"
        && ["private", "public", "secret"].includes(String(key.type || ""))
        && key.algorithm
        && Array.isArray(key.usages)
        && typeof key.extractable === "boolean"
      ) {
        try {
          Object.setPrototypeOf(key, CryptoKey.prototype);
        } catch {
          // The explicit validation below will reject an unusable value.
        }
      }
      if (!(key instanceof CryptoKey)) {
        throw new Error("One or more persisted E2EE private keys are unavailable.");
      }
    });`;

  if (!runtime.includes(before)) {
    throw new Error("Unable to install the WebKit CryptoKey prototype repair.");
  }
  runtime = runtime.replace(before, after);
  if (!runtime.includes("Object.setPrototypeOf(key, CryptoKey.prototype)")) {
    throw new Error("WebKit CryptoKey prototype repair is missing.");
  }

  await fs.writeFile(runtimePath, runtime, "utf8");
  await execFileAsync(process.execPath, ["--check", runtimePath]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

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
      if (!key || typeof key !== "object") {
        throw new Error("One or more persisted E2EE private keys are unavailable.");
      }
      // WebKit can return a fully usable CryptoKey with a corrupt prototype
      // chain. Repair it when possible, but do not use instanceof as the
      // security decision: the following real sign/derive operations validate
      // the browser's internal cryptographic slots.
      if (!(key instanceof CryptoKey)) {
        try {
          Object.setPrototypeOf(key, CryptoKey.prototype);
        } catch {
          // Some WebKit builds keep the object non-extensible. That is okay.
        }
      }
    });`;

  if (!runtime.includes(before)) {
    throw new Error("Unable to install the WebKit CryptoKey restoration patch.");
  }
  runtime = runtime.replace(before, after);
  if (!runtime.includes("the following real sign/derive operations validate")) {
    throw new Error("WebKit CryptoKey restoration patch is missing.");
  }

  await fs.writeFile(runtimePath, runtime, "utf8");
  await execFileAsync(process.execPath, ["--check", runtimePath]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

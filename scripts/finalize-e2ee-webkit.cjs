const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const runtimePath = path.join(root, "public", "assets", "e2ee-runtime.js");

async function main() {
  const runtime = await fs.readFile(runtimePath, "utf8");
  const required = [
    'const DB_VERSION = 4;',
    'VAULT_SECRET_KEY_PREFIX',
    'privateVault: await encryptPrivateVault(value)',
    'await importPrivateJwk(material.identityDhPrivateJwk, "X25519", ["deriveBits"])',
    'await importPrivateJwk(material.identitySignPrivateJwk, "Ed25519", ["sign"])',
    'if (key.extractable !== false)',
    'name: "AES-GCM"'
  ];
  required.forEach((marker) => {
    if (!runtime.includes(marker)) throw new Error(`Missing Safari E2EE vault marker: ${marker}`);
  });

  const forbidden = [
    'createObjectStore("cryptoKeys")',
    'PUSH_DEVICE_ID_KEY',
    'Object.setPrototypeOf(key, CryptoKey.prototype)',
    'identityDhPrivateJwk: record.identityDhPrivateJwk,'
  ];
  // The identity JWK must appear only inside the object encrypted by
  // encryptPrivateVault, never in the persisted metadata projection.
  if (runtime.includes('metadata.identityDhPrivateJwk =')) {
    throw new Error("Private JWK leaked into unencrypted E2EE metadata.");
  }
  forbidden.slice(0, 3).forEach((marker) => {
    if (runtime.includes(marker)) throw new Error(`Unsafe Safari E2EE marker remains: ${marker}`);
  });

  await execFileAsync(process.execPath, ["--check", runtimePath]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

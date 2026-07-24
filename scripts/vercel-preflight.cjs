const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");
const apiDirectory = path.join(root, "api");
const vercelConfigPath = path.join(root, "vercel.json");
const HOBBY_FUNCTION_LIMIT = 12;

function fail(message, details = []) {
  const suffix = details.length ? `\n${details.map((item) => `  - ${item}`).join("\n")}` : "";
  throw new Error(`[vercel-preflight] ${message}${suffix}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Cannot read valid JSON from ${path.relative(root, filePath)}.`, [error.message]);
  }
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name.startsWith(".")) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

function relativePosix(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function isPythonFunctionEntrypoint(filePath) {
  return filePath.endsWith(".py") && path.basename(filePath) !== "__init__.py";
}

function validateFunctions(config) {
  const configuredFunctions = Object.keys(config.functions || {}).sort();
  const discoveredFunctions = listFiles(apiDirectory)
    .filter(isPythonFunctionEntrypoint)
    .map(relativePosix)
    .sort();

  if (discoveredFunctions.length > HOBBY_FUNCTION_LIMIT) {
    fail(
      `The repository contains ${discoveredFunctions.length} Python Serverless Function entrypoints, but Vercel Hobby permits ${HOBBY_FUNCTION_LIMIT}. Merge new API routes into an existing function instead of adding another api/*.py entrypoint.`,
      discoveredFunctions
    );
  }

  const missingFiles = configuredFunctions.filter((filePath) => !fs.existsSync(path.join(root, filePath)));
  if (missingFiles.length) {
    fail("vercel.json configures function files that do not exist. This causes Vercel's unused_function error.", missingFiles);
  }

  const unconfiguredFiles = discoveredFunctions.filter((filePath) => !configuredFunctions.includes(filePath));
  if (unconfiguredFiles.length) {
    fail(
      "Python entrypoints inside api/ are not listed in vercel.json functions. They can still consume Serverless Function slots and silently exceed the Hobby limit.",
      unconfiguredFiles
    );
  }

  const nonPythonPatterns = configuredFunctions.filter((filePath) => !filePath.endsWith(".py"));
  if (nonPythonPatterns.length) {
    fail("Only real Python entrypoints should be listed in vercel.json functions.", nonPythonPatterns);
  }

  const rewriteDestinations = (config.rewrites || [])
    .map((rewrite) => String(rewrite?.destination || ""))
    .filter((destination) => destination.startsWith("/api/") && destination.endsWith(".py"))
    .map((destination) => destination.slice(1));

  const missingRewriteTargets = [...new Set(rewriteDestinations)]
    .filter((filePath) => !fs.existsSync(path.join(root, filePath)));
  if (missingRewriteTargets.length) {
    fail("vercel.json rewrites point to API files that do not exist.", missingRewriteTargets);
  }

  const unconfiguredRewriteTargets = [...new Set(rewriteDestinations)]
    .filter((filePath) => !configuredFunctions.includes(filePath));
  if (unconfiguredRewriteTargets.length) {
    fail("API rewrite targets must also be declared in vercel.json functions.", unconfiguredRewriteTargets);
  }

  return discoveredFunctions;
}

function validateCompressedBrandSource(fileName, expectedBytes) {
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) {
    fail(`Missing compressed brand source: scripts/${fileName}`);
  }

  const encoded = fs.readFileSync(filePath, "utf8").replace(/\s+/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    fail(`scripts/${fileName} is not valid base64 data.`);
  }

  let decoded;
  try {
    decoded = zlib.inflateSync(Buffer.from(encoded, "base64"));
  } catch (error) {
    fail(
      `scripts/${fileName} contains damaged zlib data. Do not commit a truncated or re-encoded brand source.`,
      [error.message]
    );
  }

  if (decoded.length !== expectedBytes) {
    fail(
      `scripts/${fileName} expands to the wrong size.`,
      [`expected ${expectedBytes} bytes`, `received ${decoded.length} bytes`]
    );
  }
}

function main() {
  const config = readJson(vercelConfigPath);
  const functions = validateFunctions(config);

  validateCompressedBrandSource("yachat-brand-rounded-alpha.base64", 1254 * 1254);
  validateCompressedBrandSource("yachat-brand-color-grid.base64", 64 * 64 * 3);

  console.log(
    `[vercel-preflight] OK: ${functions.length}/${HOBBY_FUNCTION_LIMIT} Python functions, all routes exist, brand sources are intact.`
  );
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}

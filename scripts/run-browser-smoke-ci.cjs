const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const reportPath = path.join(root, "runtime-smoke-report.json");
const runnerPath = path.join(__dirname, "runtime-browser-final-ci.cjs");
const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "yachat-chrome-wrapper-"));
const wrapperPath = path.join(wrapperDir, "chrome-fixed-cdp.sh");

let child = null;
let attempts = 0;
let stdout = "";
let stderr = "";
let finished = false;
let passSeen = false;
let hardTimeout = null;

function findChrome() {
  const candidates = [
    process.env.YACHAT_REAL_CHROME,
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate) && candidate !== wrapperPath) {
      return candidate;
    }
  }

  for (const command of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const result = spawnSync("which", [command], { encoding: "utf8" });
    const resolved = String(result.stdout || "").trim();
    if (result.status === 0 && resolved && resolved !== wrapperPath) return resolved;
  }

  throw new Error("Chrome/Chromium was not found for the browser smoke test.");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function createChromeWrapper(realChrome) {
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `real_chrome=${shellQuote(realChrome)}`,
    'port="$((32000 + ($$ % 20000)))"',
    'user_data_dir=""',
    'args=()',
    '',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --remote-debugging-port=0)',
    '      args+=("--remote-debugging-port=${port}")',
    '      ;;',
    '    --user-data-dir=*)',
    '      user_data_dir="${arg#--user-data-dir=}"',
    '      args+=("$arg")',
    '      ;;',
    '    *)',
    '      args+=("$arg")',
    '      ;;',
    '  esac',
    'done',
    '',
    'if [[ -n "$user_data_dir" ]]; then',
    '  mkdir -p "$user_data_dir"',
    '  printf "%s\\n" "$port" > "$user_data_dir/DevToolsActivePort"',
    'fi',
    '',
    'exec "$real_chrome" "${args[@]}"',
    ''
  ].join("\n");

  fs.writeFileSync(wrapperPath, script, { mode: 0o755 });
}

function cleanup() {
  try { fs.rmSync(wrapperDir, { recursive: true, force: true }); } catch {}
}

function writeReport(report) {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function finish({ passed, exitCode = null, signal = null, error = "" }) {
  if (finished) return;
  finished = true;
  clearTimeout(hardTimeout);
  cleanup();
  writeReport({ passed, attempts, exitCode, signal, error, stdout, stderr });
  process.exitCode = passed ? 0 : 1;
}

function stopChild() {
  try { child?.kill("SIGKILL"); } catch {}
}

function spawnAttempt() {
  attempts += 1;
  passSeen = false;
  let attemptStdout = "";
  let attemptStderr = "";

  child = spawn(process.execPath, [runnerPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CHROME_BIN: wrapperPath
    }
  });

  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    attemptStdout += text;
    stdout += text;
    process.stdout.write(text);

    if (!passSeen && attemptStdout.includes("[browser-final] PASS ")) {
      passSeen = true;
      setTimeout(() => {
        stopChild();
        finish({ passed: true, exitCode: 0, signal: "SIGKILL_AFTER_PASS" });
      }, 500);
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    attemptStderr += text;
    stderr += text;
    process.stderr.write(text);
  });

  child.on("error", (error) => {
    stopChild();
    finish({
      passed: false,
      error: error.stack || String(error)
    });
  });

  child.on("close", (code, signal) => {
    if (finished) return;
    if (passSeen) {
      finish({ passed: true, exitCode: 0, signal: signal || "closed-after-pass" });
      return;
    }

    const startupFailure = code !== 0 && (
      /DevToolsActivePort/i.test(attemptStderr)
      || /Timed out waiting for[^\n]*DevToolsActivePort/i.test(attemptStderr)
      || /Timed out waiting for CDP page target/i.test(attemptStderr)
    );

    if (startupFailure && attempts < 2) {
      const retryNotice = "\n[browser-wrapper] Chrome startup failed; retrying once with a fresh profile and debugging port.\n";
      stdout += retryNotice;
      process.stdout.write(retryNotice);
      child = null;
      setTimeout(spawnAttempt, 1200);
      return;
    }

    finish({
      passed: code === 0,
      exitCode: code,
      signal: signal || null,
      error: startupFailure ? "Chrome failed to expose a CDP target on both attempts." : ""
    });
  });
}

try {
  createChromeWrapper(findChrome());
} catch (error) {
  finish({ passed: false, error: error.stack || String(error) });
}

if (!finished) {
  hardTimeout = setTimeout(() => {
    stopChild();
    finish({
      passed: false,
      signal: "SIGKILL",
      error: "Final desktop/mobile browser smoke exceeded 240 seconds. The page or test harness remained unresponsive."
    });
  }, 240000);

  spawnAttempt();
}

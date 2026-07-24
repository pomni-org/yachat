const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const reportPath = path.join(root, "runtime-smoke-report.json");
const runnerPath = path.join(__dirname, "runtime-browser-final.cjs");

let child = null;
let attempts = 0;
let stdout = "";
let stderr = "";
let finished = false;
let passSeen = false;
let hardTimeout = null;

function writeReport(report) {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function finish({ passed, exitCode = null, signal = null, error = "" }) {
  if (finished) return;
  finished = true;
  clearTimeout(hardTimeout);
  writeReport({ passed, attempts, exitCode, signal, error, stdout, stderr });
  process.exitCode = passed ? 0 : 1;
}

function stopChild() {
  try { child?.kill("SIGKILL"); } catch {}
}

function spawnAttempt() {
  attempts += 1;
  passSeen = false;
  let attemptStderr = "";

  child = spawn(process.execPath, [runnerPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout += text;
    process.stdout.write(text);

    if (text.includes("[browser-final] PASS ")) {
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

    const startupFailure = code !== 0 && /DevToolsActivePort/i.test(attemptStderr);
    if (startupFailure && attempts < 2) {
      const retryNotice = "\n[browser-wrapper] Chrome startup failed; retrying the final smoke once.\n";
      stdout += retryNotice;
      process.stdout.write(retryNotice);
      child = null;
      setTimeout(spawnAttempt, 1500);
      return;
    }

    finish({
      passed: code === 0,
      exitCode: code,
      signal: signal || null,
      error: startupFailure ? "Chrome failed to start on both final-smoke attempts." : ""
    });
  });
}

hardTimeout = setTimeout(() => {
  stopChild();
  finish({
    passed: false,
    signal: "SIGKILL",
    error: "Final desktop/mobile browser smoke exceeded 240 seconds."
  });
}, 240000);

spawnAttempt();

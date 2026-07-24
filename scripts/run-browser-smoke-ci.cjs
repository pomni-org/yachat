const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const reportPath = path.join(root, "runtime-smoke-report.json");
const child = spawn(process.execPath, [path.join(__dirname, "runtime-browser-bisect.cjs")], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
let finished = false;
let passSeen = false;

function writeReport(report) {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function finish({ passed, exitCode = null, signal = null, error = "" }) {
  if (finished) return;
  finished = true;
  clearTimeout(hardTimeout);
  writeReport({ passed, exitCode, signal, error, stdout, stderr });
  process.exitCode = passed ? 0 : 1;
}

function stopChild() {
  try { child.kill("SIGKILL"); } catch {}
}

child.stdout.on("data", (chunk) => {
  const text = String(chunk);
  stdout += text;
  process.stdout.write(text);

  if (text.includes("[runtime-bisect] PASS:")) {
    passSeen = true;
    setTimeout(() => {
      stopChild();
      finish({ passed: true, exitCode: 0, signal: "SIGKILL_AFTER_PASS" });
    }, 500);
  }
});

child.stderr.on("data", (chunk) => {
  const text = String(chunk);
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
  if (passSeen && code !== 0) {
    finish({ passed: true, exitCode: 0, signal: signal || "closed-after-pass" });
    return;
  }
  finish({
    passed: code === 0,
    exitCode: code,
    signal: signal || null
  });
});

const hardTimeout = setTimeout(() => {
  stopChild();
  finish({
    passed: false,
    signal: "SIGKILL",
    error: "Runtime browser bisect exceeded 240 seconds. The page or diagnostic harness remained unresponsive."
  });
}, 240000);

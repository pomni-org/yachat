const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const reportPath = path.join(root, "runtime-smoke-report.json");
const child = spawn(process.execPath, [path.join(__dirname, "runtime-browser-smoke.cjs")], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
let finished = false;

function writeReport(report) {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

child.stdout.on("data", (chunk) => {
  const text = String(chunk);
  stdout += text;
  process.stdout.write(text);
});

child.stderr.on("data", (chunk) => {
  const text = String(chunk);
  stderr += text;
  process.stderr.write(text);
});

child.on("error", (error) => {
  if (finished) return;
  finished = true;
  writeReport({
    passed: false,
    exitCode: null,
    error: error.stack || String(error),
    stdout,
    stderr
  });
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  if (finished) return;
  finished = true;
  writeReport({
    passed: code === 0,
    exitCode: code,
    signal: signal || null,
    stdout,
    stderr
  });
  process.exitCode = code || 0;
});

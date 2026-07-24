const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const reportPath = path.join(root, "runtime-smoke-report.json");
const child = spawn(process.execPath, [path.join(__dirname, "runtime-browser-cdp-smoke.cjs")], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";

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
  const report = {
    passed: false,
    exitCode: null,
    error: error.stack || String(error),
    stdout,
    stderr
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  const report = {
    passed: code === 0,
    exitCode: code,
    signal: signal || null,
    stdout,
    stderr
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.exitCode = code || 0;
});

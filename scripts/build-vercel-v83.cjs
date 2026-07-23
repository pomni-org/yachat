const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "public");
const previousVersion = "82";
const currentVersion = "83";

const build = spawnSync(process.execPath, [path.join(__dirname, "build-vercel.cjs")], {
  cwd: root,
  stdio: "inherit"
});

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);

function rewriteVersion(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    fs.readdirSync(target).forEach((name) => rewriteVersion(path.join(target, name)));
    return;
  }

  if (!/\.(?:html?|css|js|json|webmanifest|xml|txt)$/i.test(target)) return;
  const source = fs.readFileSync(target, "utf8");
  const updated = source.replaceAll(`?v=${previousVersion}`, `?v=${currentVersion}`);
  if (updated !== source) fs.writeFileSync(target, updated, "utf8");
}

rewriteVersion(output);

const index = fs.readFileSync(path.join(output, "index.html"), "utf8");
for (const asset of [
  `/assets/composer-delivery-stable.js?v=${currentVersion}`,
  `/assets/composer-actions-stable.js?v=${currentVersion}`,
  `/assets/avatar-preserve.css?v=${currentVersion}`,
  `/assets/avatar-preserve.js?v=${currentVersion}`
]) {
  if (!index.includes(asset)) throw new Error(`Missing v${currentVersion} asset: ${asset}`);
}

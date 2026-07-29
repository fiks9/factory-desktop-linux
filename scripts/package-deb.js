"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { sha256 } = require("./runtime");

function copyRecursive(source, destination) {
  fs.cpSync(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
}

function assertNoWorkspaceSymlinks(root) {
  const forbidden = ["/home/runner", "/tmp/", process.cwd()];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        if (path.isAbsolute(target) || forbidden.some((value) => target.includes(value))) {
          throw new Error(`Package contains forbidden symlink: ${full} -> ${target}`);
        }
      } else if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
}

function buildDeb(options) {
  const appDir = path.resolve(options.appDir);
  const version = options.version;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid package version: ${version}`);
  if (!fs.existsSync(path.join(appDir, "resources", "app.asar"))) throw new Error("Staged app is missing resources/app.asar");
  if (!fs.existsSync(path.join(appDir, "factory-desktop"))) throw new Error("Staged app is missing factory-desktop launcher");
  assertNoWorkspaceSymlinks(appDir);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-deb-"));
  const root = path.join(temp, "root");
  const control = path.join(root, "DEBIAN");
  fs.mkdirSync(control, { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(root, "opt", "Factory"), { recursive: true });
  fs.mkdirSync(path.join(root, "usr", "share", "applications"), { recursive: true });
  fs.mkdirSync(path.join(root, "usr", "share", "icons", "hicolor", "512x512", "apps"), { recursive: true });
  copyRecursive(appDir, path.join(root, "opt", "Factory"));

  const desktop = path.resolve(__dirname, "..", "packaging", "linux", "factory-desktop.desktop");
  fs.copyFileSync(desktop, path.join(root, "usr", "share", "applications", "factory-desktop.desktop"));
  if (options.iconPath && fs.existsSync(options.iconPath)) fs.copyFileSync(options.iconPath, path.join(root, "usr", "share", "icons", "hicolor", "512x512", "apps", "factory-desktop.png"));
  for (const script of ["factory-desktop.postinst", "factory-desktop.prerm", "factory-desktop.postrm"]) {
    fs.copyFileSync(path.resolve(__dirname, "..", "packaging", "linux", script), path.join(control, script));
    fs.chmodSync(path.join(control, script), 0o755);
  }
  const controlText = [
    "Package: factory-desktop",
    `Version: ${version}`,
    "Section: devel",
    "Priority: optional",
    "Architecture: amd64",
    "Maintainer: Factory Desktop Linux contributors",
    "Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils",
    "Description: Unofficial Factory Desktop Linux wrapper",
    " Linux compatibility wrapper built from an authorized Factory Desktop DMG.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(control, "control"), controlText, { mode: 0o644 });
  const outputDir = path.resolve(options.outputDir || path.join(process.cwd(), "dist"));
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, `factory-desktop_${version}_amd64.deb`);
  fs.rmSync(output, { force: true });
  execFileSync("dpkg-deb", ["--build", "--root-owner-group", root, output], { stdio: "inherit", timeout: 10 * 60 * 1000 });
  return { path: output, sha256: sha256(output), bytes: fs.statSync(output).size };
}

if (require.main === module) {
  const [appDir, version, outputDir] = process.argv.slice(2);
  if (!appDir || !version) {
    console.error("Usage: node scripts/package-deb.js /absolute/staged-app version [output-dir]");
    process.exit(2);
  }
  try { console.log(JSON.stringify(buildDeb({ appDir, version, outputDir }), null, 2)); }
  catch (error) { console.error(`Deb build failed: ${error.message}`); process.exit(1); }
}

module.exports = { buildDeb, assertNoWorkspaceSymlinks };

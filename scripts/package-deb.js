"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { PRODUCT_BINARY_NAME, assertPackagedRuntimeLayout, sha256 } = require("./runtime");
const { scanPackageTree, stageInstalledUpdateBuilder } = require("./package-hygiene");
const { writePackageBuildInfo } = require("./release-metadata");
const { validateAppJavaScript } = require("./validate-app-javascript");
const { releaseIdentity } = require("./release-identity");

const REQUIRED_PATCHES = [
  "daemon-transport-force-websocket",
  "prevent-listen-ipc",
  "system-daemon-adoption",
  "system-droid-cli-resolver",
  "linux-native-updater-button",
  "auto-updater-guard",
  "packaged-daemon-mode",
  "disable-keyring",
  "protocol-handler",
  "bundle-javascript-syntax",
];

function copyRecursive(source, destination) {
  fs.cpSync(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
}

function resolveUpdaterBinary(options = {}) {
  const candidate = options.updaterBinary || process.env.FACTORY_UPDATE_MANAGER_BINARY || path.resolve(__dirname, "..", "updater", "target", "release", "factory-update-manager");
  if (!path.isAbsolute(candidate)) throw new Error("Updater binary path must be absolute");
  const stat = fs.statSync(candidate, { throwIfNoEntry: false });
  if (!stat?.isFile() || !(stat.mode & 0o111)) throw new Error(`Native package requires an executable factory-update-manager: ${candidate}`);
  return candidate;
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

function assertNoBundledDroid(appDir) {
  const droidPath = path.join(appDir, "resources", "bin", "droid");
  if (fs.existsSync(droidPath)) {
    throw new Error(`Staged app must not contain resources/bin/droid: ${droidPath}`);
  }
}

function assertAcceptedPatchReport(appDir) {
  const reportPath = path.join(appDir, ".factory-linux", "patch-report.json");
  if (!fs.existsSync(reportPath)) throw new Error(`Staged app is missing required patch report: ${reportPath}`);
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`Patch report is invalid JSON: ${error.message}`);
  }
  for (const id of REQUIRED_PATCHES) {
    const outcome = report.outcomes?.find((candidate) => candidate.id === id);
    if (!outcome || !outcome.validationPassed || !(outcome.matched || outcome.alreadyPatched)) {
      throw new Error(`Required patch was not accepted: ${id}`);
    }
  }
  const asarHash = sha256(path.join(appDir, "resources", "app.asar"));
  if (!report.finalHash || report.finalHash !== asarHash) {
    throw new Error(`Patch report hash does not match staged app.asar: expected ${report.finalHash || "missing"}, got ${asarHash}`);
  }
  return report;
}

function buildDeb(options) {
  const appDir = path.resolve(options.appDir);
  const identity = releaseIdentity(options.version, options.wrapperRevision ?? null);
  const version = identity.factoryVersion;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid package version: ${version}`);
  if (!fs.existsSync(path.join(appDir, "resources", "app.asar"))) throw new Error("Staged app is missing resources/app.asar");
  assertPackagedRuntimeLayout(appDir, { binaryName: PRODUCT_BINARY_NAME });
  assertNoWorkspaceSymlinks(appDir);
  assertNoBundledDroid(appDir);
  assertAcceptedPatchReport(appDir);
  validateAppJavaScript(appDir);
  scanPackageTree(appDir, { workspaceRoot: process.cwd() });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-deb-"));
  try {
  const root = path.join(temp, "root");
  const control = path.join(root, "DEBIAN");
  fs.mkdirSync(control, { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(root, "opt", "Factory"), { recursive: true });
  fs.mkdirSync(path.join(root, "usr", "share", "applications"), { recursive: true });
  fs.mkdirSync(path.join(root, "usr", "share", "icons", "hicolor", "512x512", "apps"), { recursive: true });
  fs.mkdirSync(path.join(root, "usr", "lib", "factory-desktop"), { recursive: true });
  fs.mkdirSync(path.join(root, "usr", "lib", "factory-desktop", "update-builder"), { recursive: true });
  fs.mkdirSync(path.join(root, "usr", "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "usr", "lib", "systemd", "user"), { recursive: true });
  fs.mkdirSync(path.join(root, "usr", "share", "polkit-1", "actions"), { recursive: true });
  copyRecursive(appDir, path.join(root, "opt", "Factory"));
  writePackageBuildInfo(path.join(root, "opt", "Factory"), "deb", { wrapperRevision: identity.wrapperRevision });

  const desktop = path.resolve(__dirname, "..", "packaging", "linux", "factory-desktop.desktop");
  fs.copyFileSync(desktop, path.join(root, "usr", "share", "applications", "factory-desktop.desktop"));
  const daemonScript = path.resolve(__dirname, "..", "packaging", "linux", "factory-droid-daemon.sh");
  const daemonService = path.resolve(__dirname, "..", "packaging", "linux", "factory-droid-daemon.service");
  fs.copyFileSync(daemonScript, path.join(root, "usr", "lib", "factory-desktop", "factory-droid-daemon"));
  fs.chmodSync(path.join(root, "usr", "lib", "factory-desktop", "factory-droid-daemon"), 0o755);
  fs.copyFileSync(daemonService, path.join(root, "usr", "lib", "systemd", "user", "factory-droid-daemon.service"));
  fs.copyFileSync(path.resolve(__dirname, "..", "packaging", "linux", "factory-update-manager.service"), path.join(root, "usr", "lib", "systemd", "user", "factory-update-manager.service"));
  fs.copyFileSync(path.resolve(__dirname, "..", "packaging", "linux", "update-bridge.cjs"), path.join(root, "usr", "lib", "factory-desktop", "update-bridge.cjs"));
  fs.chmodSync(path.join(root, "usr", "lib", "factory-desktop", "update-bridge.cjs"), 0o644);
  fs.copyFileSync(path.resolve(__dirname, "..", "packaging", "linux", "org.factory.desktop.update-manager.policy"), path.join(root, "usr", "share", "polkit-1", "actions", "org.factory.desktop.update-manager.policy"));
  fs.copyFileSync(resolveUpdaterBinary(options), path.join(root, "usr", "bin", "factory-update-manager"));
  fs.chmodSync(path.join(root, "usr", "bin", "factory-update-manager"), 0o755);
  stageInstalledUpdateBuilder(path.resolve(__dirname, ".."), path.join(root, "usr", "lib", "factory-desktop", "update-builder"));
  if (options.iconPath && fs.existsSync(options.iconPath)) fs.copyFileSync(options.iconPath, path.join(root, "usr", "share", "icons", "hicolor", "512x512", "apps", "factory-desktop.png"));
  for (const name of ["postinst", "prerm", "postrm"]) {
    const source = path.resolve(__dirname, "..", "packaging", "linux", `factory-desktop.${name}`);
    fs.copyFileSync(source, path.join(control, name));
    fs.chmodSync(path.join(control, name), 0o755);
  }
  const controlText = [
    "Package: factory-desktop",
    `Version: ${identity.debVersion}`,
    "Section: devel",
    "Priority: optional",
    "Architecture: amd64",
    "Maintainer: Factory Desktop Linux contributors",
    "Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, nodejs, npm, xdg-utils",
    "Description: Unofficial Factory Desktop Linux wrapper",
    " Linux compatibility wrapper built from an authorized Factory Desktop DMG.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(control, "control"), controlText, { mode: 0o644 });
  const outputDir = path.resolve(options.outputDir || path.join(process.cwd(), "dist"));
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, identity.debFilename);
  fs.rmSync(output, { force: true });
  execFileSync("dpkg-deb", ["--build", "--root-owner-group", root, output], { stdio: "inherit", timeout: 10 * 60 * 1000 });
  const extracted = path.join(temp, "extracted");
  execFileSync("dpkg-deb", ["--extract", output, extracted], { stdio: "ignore", timeout: 10 * 60 * 1000 });
  scanPackageTree(extracted, { workspaceRoot: process.cwd() });
  return { path: output, sha256: sha256(output), bytes: fs.statSync(output).size };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
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

module.exports = { buildDeb, assertNoWorkspaceSymlinks, assertNoBundledDroid, assertAcceptedPatchReport, resolveUpdaterBinary };

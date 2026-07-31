"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { extractPngIconFromIcns, readPngDimensions } = require("./icon");

const PRODUCT_BINARY_NAME = "factory-desktop";
const LAUNCHER_NAME = "factory-desktop-launcher";

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), destination).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`Electron download returned HTTP ${response.statusCode}`));
        return;
      }
      const stream = fs.createWriteStream(destination, { mode: 0o600 });
      response.pipe(stream);
      stream.on("finish", () => stream.close(resolve));
      stream.on("error", reject);
      response.on("error", reject);
    });
    request.setTimeout(10 * 60 * 1000, () => request.destroy(new Error("Electron download timed out")));
    request.on("error", reject);
  });
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function electronZipUrl(version, arch = "x64") {
  return `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-linux-${arch}.zip`;
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function assertPackagedRuntimeLayout(appDir, options = {}) {
  const binaryName = options.binaryName || PRODUCT_BINARY_NAME;
  if (binaryName === "electron") throw new Error("Packaged binary name must not be electron");
  const binaryPath = path.join(appDir, binaryName);
  const legacyElectronPath = path.join(appDir, "electron");
  const asarPath = path.join(appDir, "resources", "app.asar");
  const iconPath = path.join(appDir, "resources", "factory-desktop.png");
  const launcherPath = path.join(appDir, LAUNCHER_NAME);
  if (!isExecutable(binaryPath)) throw new Error(`Packaged product binary is missing or not executable: ${binaryPath}`);
  const magic = fs.readFileSync(binaryPath).subarray(0, 4);
  if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error(`Packaged product binary is not an ELF executable: ${binaryPath}`);
  if (fs.existsSync(legacyElectronPath)) throw new Error(`Staged runtime must not retain the electron binary name: ${legacyElectronPath}`);
  if (!fs.statSync(asarPath, { throwIfNoEntry: false })?.isFile()) throw new Error(`Staged runtime is missing resources/app.asar: ${asarPath}`);
  const iconMetadata = fs.lstatSync(iconPath, { throwIfNoEntry: false });
  if (!iconMetadata?.isFile() || iconMetadata.isSymbolicLink()) throw new Error(`Staged runtime is missing its regular factory-desktop.png icon: ${iconPath}`);
  const iconDimensions = readPngDimensions(fs.readFileSync(iconPath));
  if (iconDimensions.width !== 512 || iconDimensions.height !== 512) throw new Error(`Staged runtime icon must be exactly 512x512: ${iconPath}`);
  if (!isExecutable(launcherPath)) throw new Error(`Packaged launcher is missing or not executable: ${launcherPath}`);
  const launcher = fs.readFileSync(launcherPath, "utf8");
  if (!launcher.includes(`exec "$APP_ROOT/${binaryName}" "$@"`)) throw new Error(`Launcher does not exec the product-named binary: ${launcherPath}`);
  if (launcher.includes("droid-dev") || launcher.includes("--debug")) throw new Error("Packaged launcher must not inject droid-dev or --debug");
  const buildInfoPath = path.join(appDir, "build-info.json");
  if (fs.existsSync(buildInfoPath)) {
    const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
    if (buildInfo.binaryName !== binaryName) throw new Error(`build-info binaryName mismatch: expected ${binaryName}, got ${buildInfo.binaryName}`);
  }
  return { binaryName, binaryPath, launcherName: LAUNCHER_NAME, asarPath, iconPath };
}

async function assembleRuntime(options) {
  const { extracted, outputDir, patchedAsarPath } = options;
  if (!extracted || !extracted.electronVersion || !extracted.appAsarPath) throw new Error("Runtime assembly requires extracted Electron metadata and app.asar");
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o755 });
  const cacheDir = options.cacheDir || path.join(outputDir, ".cache");
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const zipPath = path.join(cacheDir, `electron-${extracted.electronVersion}-linux-x64.zip`);
  const sourceAsar = patchedAsarPath || extracted.appAsarPath;
  if (!fs.existsSync(sourceAsar)) throw new Error(`ASAR hook input does not exist: ${sourceAsar}`);
  return assembleRuntimeAsync({ ...options, zipPath, sourceAsar, sourceUnpacked: options.unpackedPath || extracted.appAsarUnpackedPath || `${sourceAsar}.unpacked` });
}

async function assembleRuntimeAsync(options) {
  const { extracted, outputDir, zipPath, sourceAsar, sourceUnpacked } = options;
  if (!fs.existsSync(zipPath)) await download(electronZipUrl(extracted.electronVersion), zipPath);
  const temporary = `${outputDir}.runtime-${process.pid}`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true, mode: 0o755 });
  const sevenZip = process.env.SEVEN_ZIP || (fs.existsSync("/usr/bin/7zz") ? "/usr/bin/7zz" : "7z");
  execFileSync(sevenZip, ["x", "-y", `-o${temporary}`, zipPath], { stdio: "ignore", timeout: 10 * 60 * 1000 });
  const electronBinary = path.join(temporary, "electron");
  const productBinary = path.join(temporary, PRODUCT_BINARY_NAME);
  if (!isExecutable(electronBinary)) throw new Error(`Electron archive is missing its executable: ${electronBinary}`);
  fs.renameSync(electronBinary, productBinary);
  fs.mkdirSync(path.join(temporary, "resources"), { recursive: true });
  fs.copyFileSync(sourceAsar, path.join(temporary, "resources", "app.asar"));
  const companion = sourceUnpacked || extracted.appAsarUnpackedPath || `${sourceAsar}.unpacked`;
  if (companion && fs.existsSync(companion)) {
    const unpackedTarget = path.join(temporary, "resources", "app.asar.unpacked");
    fs.cpSync(companion, unpackedTarget, { recursive: true, dereference: false, force: true });
  }
  if (!extracted.iconPath) throw new Error("DMG acceptance did not provide the Factory application icon");
  extractPngIconFromIcns(extracted.iconPath, path.join(temporary, "resources", "factory-desktop.png"), 512);
  fs.copyFileSync(path.join(__dirname, "..", "launcher", "start.sh.template"), path.join(temporary, LAUNCHER_NAME));
  fs.chmodSync(path.join(temporary, LAUNCHER_NAME), 0o755);
  fs.rmSync(path.join(temporary, "resources", "default_app.asar"), { force: true });
  assertPackagedRuntimeLayout(temporary);
  fs.rmSync(path.join(outputDir), { recursive: true, force: true });
  fs.renameSync(temporary, outputDir);
  return {
    outputDir,
    electronVersion: extracted.electronVersion,
    binaryName: PRODUCT_BINARY_NAME,
    launcherName: LAUNCHER_NAME,
    appAsar: path.join(outputDir, "resources", "app.asar"),
    appAsarSha256: sha256(path.join(outputDir, "resources", "app.asar")),
    electronZip: zipPath,
  };
}

module.exports = { PRODUCT_BINARY_NAME, LAUNCHER_NAME, electronZipUrl, assembleRuntime, assembleRuntimeAsync, assertPackagedRuntimeLayout, sha256 };

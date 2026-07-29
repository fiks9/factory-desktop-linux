"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

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

async function assembleRuntime(options) {
  const { extracted, outputDir, patchedAsarPath } = options;
  if (!extracted || !extracted.electronVersion || !extracted.appAsarPath) throw new Error("Runtime assembly requires extracted Electron metadata and app.asar");
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o755 });
  const cacheDir = options.cacheDir || path.join(outputDir, ".cache");
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const zipPath = path.join(cacheDir, `electron-${extracted.electronVersion}-linux-x64.zip`);
  const sourceAsar = patchedAsarPath || extracted.appAsarPath;
  if (!fs.existsSync(sourceAsar)) throw new Error(`ASAR hook input does not exist: ${sourceAsar}`);
  return assembleRuntimeAsync({ ...options, zipPath, sourceAsar });
}

async function assembleRuntimeAsync(options) {
  const { extracted, outputDir, zipPath, sourceAsar } = options;
  if (!fs.existsSync(zipPath)) await download(electronZipUrl(extracted.electronVersion), zipPath);
  const temporary = `${outputDir}.runtime-${process.pid}`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true, mode: 0o755 });
  const sevenZip = process.env.SEVEN_ZIP || (fs.existsSync("/usr/bin/7zz") ? "/usr/bin/7zz" : "7z");
  execFileSync(sevenZip, ["x", "-y", `-o${temporary}`, zipPath], { stdio: "ignore", timeout: 10 * 60 * 1000 });
  fs.mkdirSync(path.join(temporary, "resources"), { recursive: true });
  fs.copyFileSync(sourceAsar, path.join(temporary, "resources", "app.asar"));
  fs.copyFileSync(path.join(__dirname, "..", "launcher", "start.sh.template"), path.join(temporary, "factory-desktop"));
  fs.chmodSync(path.join(temporary, "factory-desktop"), 0o755);
  fs.rmSync(path.join(temporary, "resources", "default_app.asar"), { force: true });
  fs.rmSync(path.join(outputDir), { recursive: true, force: true });
  fs.renameSync(temporary, outputDir);
  return {
    outputDir,
    electronVersion: extracted.electronVersion,
    appAsar: path.join(outputDir, "resources", "app.asar"),
    appAsarSha256: sha256(path.join(outputDir, "resources", "app.asar")),
    electronZip: zipPath,
  };
}

module.exports = { electronZipUrl, assembleRuntime, assembleRuntimeAsync, sha256 };

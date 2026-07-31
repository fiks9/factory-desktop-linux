"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const asar = require("@electron/asar");

function escapedGlob(value) {
  return value.replace(/[\\*?\[\]{}()!+@]/g, "\\$&");
}

function unpackedPatterns(asarPath, sourceRoot) {
  const entries = asar.listPackage(asarPath, { isPack: true })
    .filter((entry) => entry.startsWith("unpack : "))
    .map((entry) => entry.slice("unpack : /".length));
  const filePatterns = [];
  const directoryPatterns = [];
  for (const entry of entries) {
    const metadata = asar.statFile(asarPath, entry);
    const absolute = escapedGlob(path.join(sourceRoot, entry));
    if (metadata && metadata.files) directoryPatterns.push(absolute);
    else filePatterns.push(absolute);
  }
  if (filePatterns.length === 0 && directoryPatterns.length === 0) return undefined;
  const brace = (patterns) => patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
  return {
    unpack: filePatterns.length ? brace(filePatterns) : undefined,
    unpackDir: directoryPatterns.length ? brace(directoryPatterns) : undefined,
  };
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let read;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function listJavaScriptFiles(asarPath) {
  asar.uncache(asarPath);
  return asar.listPackage(asarPath).filter((file) => /\.js$/.test(file)).map((file) => file.replace(/^\/+/, ""));
}

function readFile(asarPath, filePath) {
  asar.uncache(asarPath);
  return asar.extractFile(asarPath, filePath).toString("utf8");
}

async function replaceFilesAtomic(asarPath, changes, options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-asar-"));
  const extractedDir = path.join(tempDir, "payload");
  const rebuilt = path.join(tempDir, "app.asar");
  const unpackedPath = options.unpackedPath || `${asarPath}.unpacked`;
  const originalUnpacked = `${asarPath}.unpacked`;
  const unpackPattern = unpackedPatterns(asarPath, extractedDir);
  try {
    if (unpackPattern && !fs.existsSync(unpackedPath)) {
      throw new Error(`ASAR companion tree is missing for unpacked entries: ${unpackedPath}`);
    }
    asar.extractAll(asarPath, extractedDir);
    for (const [relative, content] of changes) {
      const destination = path.join(extractedDir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    await asar.createPackageWithOptions(extractedDir, rebuilt, unpackPattern || {});
    asar.uncache(asarPath);
    const original = `${asarPath}.phase2-original-${process.pid}`;
    const originalCompanion = `${original}.unpacked`;
    const rebuiltCompanion = `${rebuilt}.unpacked`;
    const hadOriginalCompanion = fs.existsSync(originalUnpacked);
    fs.renameSync(asarPath, original);
    if (hadOriginalCompanion) fs.renameSync(originalUnpacked, originalCompanion);
    try {
      fs.renameSync(rebuilt, asarPath);
      if (fs.existsSync(rebuiltCompanion)) fs.renameSync(rebuiltCompanion, originalUnpacked);
      asar.uncache(asarPath);
      fs.rmSync(original, { force: true });
      fs.rmSync(originalCompanion, { recursive: true, force: true });
    } catch (error) {
      fs.rmSync(asarPath, { force: true });
      fs.rmSync(originalUnpacked, { recursive: true, force: true });
      fs.renameSync(original, asarPath);
      if (hadOriginalCompanion) fs.renameSync(originalCompanion, originalUnpacked);
      throw error;
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { sha256File, listJavaScriptFiles, readFile, replaceFilesAtomic, unpackedPatterns };

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const asar = require("@electron/asar");

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

async function replaceFilesAtomic(asarPath, changes) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-asar-"));
  const extractedDir = path.join(tempDir, "payload");
  const rebuilt = path.join(tempDir, "app.asar");
  try {
    asar.extractAll(asarPath, extractedDir);
    for (const [relative, content] of changes) {
      const destination = path.join(extractedDir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    await asar.createPackage(extractedDir, rebuilt);
    asar.uncache(asarPath);
    const original = `${asarPath}.phase2-original-${process.pid}`;
    fs.renameSync(asarPath, original);
    try {
      fs.renameSync(rebuilt, asarPath);
      asar.uncache(asarPath);
      fs.rmSync(original, { force: true });
    } catch (error) {
      fs.renameSync(original, asarPath);
      throw error;
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { sha256File, listJavaScriptFiles, readFile, replaceFilesAtomic };

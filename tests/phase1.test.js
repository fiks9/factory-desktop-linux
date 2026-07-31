"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { test, before, after } = require("node:test");
const {
  acquireExactDmg,
  buildExactDownloadUrl,
  parseVersion,
  parseVersionFromUrl,
  discoverLatestVersion,
  resolveOfficialDmgRedirect,
  streamToContentAddressed,
  cachePinnedDmg,
  validateOfficialDmgUrl,
} = require("../scripts/dmg");
const { findAppAsarUnpacked, plistValue, validateDmgFile } = require("../scripts/extract-dmg");
const { execFileSync } = require("node:child_process");
const { assertNoBundledDroid, assertAcceptedPatchReport } = require("../scripts/package-deb");
const { PRODUCT_BINARY_NAME, assertPackagedRuntimeLayout } = require("../scripts/runtime");
const { assembleRuntimeAsync } = require("../scripts/runtime");
const { extractPngIconFromIcns, readPngDimensions } = require("../scripts/icon");
const zlib = require("node:zlib");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

function solidPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 4);
  for (let index = 1; index < row.length; index += 4) row.set([23, 23, 23, 255], index);
  const image = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(image)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function icnsWithPng(type, png) {
  const entry = Buffer.alloc(8 + png.length);
  entry.write(type, 0, 4, "ascii");
  entry.writeUInt32BE(entry.length, 4);
  png.copy(entry, 8);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(header.length + entry.length, 4);
  return Buffer.concat([header, entry]);
}

let server;
let baseUrl;

before(async () => {
  server = http.createServer((request, response) => {
    if (request.url === "/latest") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ latestVersion: "0.139.0" }));
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/release/Factory-0.139.0.dmg" });
      response.end();
      return;
    }
    if (request.url === "/release/Factory-0.139.0.dmg") {
      response.end(Buffer.from("phase1-dmg-content"));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("Factory endpoint version parsing is strict", () => {
  assert.equal(parseVersion("0.139.0"), "0.139.0");
  assert.equal(parseVersionFromUrl("https://cdn.example/releases/0.139.0/darwin/x64/Factory.dmg"), "0.139.0");
  assert.throws(() => parseVersion("latest"), /Invalid Factory version/);
});

test("latest-version discovery reads the documented JSON contract", async () => {
  assert.equal(await discoverLatestVersion({ endpoint: `${baseUrl}/latest` }), "0.139.0");
});

test("exact Factory 0.139.0 acquisition uses the confined official versioned object", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-phase1-exact-"));
  try {
    const expectedUrl = "https://s3.us-west-1.amazonaws.com/downloads.factory.ai/factory-desktop/releases/0.139.0/darwin/x64/Factory-0.139.0-x64.dmg";
    assert.equal(buildExactDownloadUrl("0.139.0"), expectedUrl);
    const result = await acquireExactDmg({
      version: "0.139.0",
      cacheDir: root,
      download: async (url, cacheDir, options) => {
        assert.equal(url, expectedUrl);
        assert.equal(cacheDir, root);
        assert.equal(options.validateUrl(url), expectedUrl);
        const file = path.join(root, `Factory-${"a".repeat(64)}.dmg`);
        fs.writeFileSync(file, "exact fixture");
        return { path: file, sha256: "a".repeat(64), bytes: 13, finalUrl: url };
      },
    });
    assert.equal(result.version, "0.139.0");
    assert.equal(result.source, "official");
    assert.equal(result.finalUrl, expectedUrl);
    assert.throws(() => buildExactDownloadUrl("latest"), /Invalid Factory version/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exact acquisition rejects a redirect from 0.139.0 to 0.140.0", () => {
  const current = buildExactDownloadUrl("0.139.0");
  const changed = buildExactDownloadUrl("0.140.0");
  assert.throws(
    () => resolveOfficialDmgRedirect(current, changed, "0.139.0"),
    /official Factory DMG path|version/i,
  );
});

test("exact acquisition rejects non-HTTPS, foreign hosts, paths, and query strings", () => {
  const expected = buildExactDownloadUrl("0.139.0");
  assert.equal(validateOfficialDmgUrl(expected, "0.139.0"), expected);
  for (const invalid of [
    expected.replace("https:", "http:"),
    expected.replace("s3.us-west-1.amazonaws.com", "downloads.example.com"),
    expected.replace("/downloads.factory.ai/", "/untrusted-bucket/"),
    `${expected}?redirect=1`,
  ]) {
    assert.throws(() => validateOfficialDmgUrl(invalid, "0.139.0"), /official Factory DMG URL/i);
  }
});

test("download streams into an immutable content-addressed cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-phase1-cache-"));
  const first = await streamToContentAddressed(`${baseUrl}/redirect`, root);
  const second = await streamToContentAddressed(`${baseUrl}/redirect`, root);
  assert.equal(first.path, second.path);
  assert.match(path.basename(first.path), /^Factory-[0-9a-f]{64}\.dmg$/);
  assert.equal(fs.readFileSync(first.path, "utf8"), "phase1-dmg-content");
  assert.deepEqual(fs.readdirSync(root), [path.basename(first.path)]);
  assert.equal(fs.lstatSync(first.path).isSymbolicLink(), false);
});

test("pinned DMGs are copied into the same immutable cache", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-phase1-pinned-"));
  const source = path.join(root, "source.dmg");
  fs.writeFileSync(source, "authorized local DMG placeholder");
  const cached = cachePinnedDmg(source, path.join(root, "downloads"));
  assert.match(cached.path, /Factory-[0-9a-f]{64}\.dmg$/);
  assert.equal(cached.source, "pinned");
  assert.equal(fs.readFileSync(cached.path, "utf8"), "authorized local DMG placeholder");
  assert.throws(() => cachePinnedDmg("relative.dmg", path.join(root, "downloads")), /absolute/);
});

test("plist parsing exposes Factory and Electron versions", () => {
  const plist = '<key>CFBundleShortVersionString</key><string>0.139.0</string>';
  assert.equal(plistValue(plist, "CFBundleShortVersionString"), "0.139.0");
});

test("Factory ICNS conversion writes a structurally valid 512px PNG", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-icon-conversion-"));
  try {
    const source = path.join(root, "factory.icns");
    const output = path.join(root, "factory-desktop.png");
    fs.writeFileSync(source, icnsWithPng("ic09", solidPng(512, 512)));

    const result = extractPngIconFromIcns(source, output, 512);

    assert.deepEqual(readPngDimensions(fs.readFileSync(output)), { width: 512, height: 512 });
    assert.equal(result.width, 512);
    assert.equal(result.height, 512);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(output).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Factory ICNS conversion fails closed for malformed or missing 512px PNG data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-icon-rejection-"));
  try {
    const malformed = path.join(root, "malformed.icns");
    const wrongSize = path.join(root, "wrong-size.icns");
    fs.writeFileSync(malformed, Buffer.from("not-icns"));
    fs.writeFileSync(wrongSize, icnsWithPng("ic08", solidPng(256, 256)));

    assert.throws(() => extractPngIconFromIcns(malformed, path.join(root, "bad.png"), 512), /ICNS/i);
    assert.throws(() => extractPngIconFromIcns(wrongSize, path.join(root, "small.png"), 512), /512/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DMG acceptance fails closed when required app entries are absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-phase1-invalid-"));
  const invalid = path.join(root, "not-a-dmg");
  fs.writeFileSync(invalid, "not a DMG");
  process.env.SEVEN_ZIP = path.join(root, "missing-7z");
  assert.throws(() => validateDmgFile(invalid), /spawn|ENOENT|DMG|7z/i);
  delete process.env.SEVEN_ZIP;
});

test("DMG acceptance recognizes a synthetic Factory-shaped archive", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-phase1-shaped-"));
  const tree = path.join(root, "Factory", "Factory.app", "Contents");
  fs.mkdirSync(path.join(tree, "Resources"), { recursive: true });
  fs.mkdirSync(path.join(tree, "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources"), { recursive: true });
  fs.writeFileSync(path.join(tree, "Info.plist"), '<key>CFBundleShortVersionString</key><string>0.139.0</string>\n');
  fs.writeFileSync(path.join(tree, "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources", "Info.plist"), '<key>CFBundleVersion</key><string>37.2.6</string>\n');
  fs.writeFileSync(path.join(tree, "Resources", "app.asar"), "synthetic asar");
  const dmg = path.join(root, "Factory.dmg");
  execFileSync("7z", ["a", "-t7z", dmg, "Factory"], { cwd: root, stdio: "ignore" });
  const accepted = validateDmgFile(dmg);
  assert.equal(accepted.appAsarEntry, "Factory/Factory.app/Contents/Resources/app.asar");
  assert.equal(accepted.infoEntry, "Factory/Factory.app/Contents/Info.plist");
});

test("DMG acceptance identifies the optional app.asar.unpacked companion", () => {
  const listing = [
    "Path = Factory/Factory.app/Contents/Resources/app.asar",
    "Path = Factory/Factory.app/Contents/Resources/app.asar.unpacked",
    "Path = Factory/Factory.app/Contents/Resources/app.asar.unpacked/node_modules/keytar/build/Release/keytar.node",
  ].join("\n");
  assert.equal(findAppAsarUnpacked(listing), "Factory/Factory.app/Contents/Resources/app.asar.unpacked");
  assert.equal(findAppAsarUnpacked("Path = Factory/Factory.app/Contents/Resources/app.asar"), null);
});

test("package validation rejects an accidentally bundled droid", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-phase2-droid-"));
  fs.mkdirSync(path.join(root, "resources", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "resources", "bin", "droid"), "binary placeholder");
  assert.throws(() => assertNoBundledDroid(root), /must not contain resources\/bin\/droid/);
});

test("package validation fails closed without an accepted patch report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-phase2-report-"));
  assert.throws(() => assertAcceptedPatchReport(root), /missing required patch report/);
  fs.mkdirSync(path.join(root, ".factory-linux"), { recursive: true });
  fs.writeFileSync(path.join(root, ".factory-linux", "patch-report.json"), JSON.stringify({ outcomes: [] }));
  assert.throws(() => assertAcceptedPatchReport(root), /Required patch was not accepted/);
});

function writeSyntheticElf(filePath) {
  fs.writeFileSync(filePath, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("synthetic runtime")]), { mode: 0o755 });
}

test("packaged runtime uses a product-named ELF beside resources/app.asar", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-packaged-layout-"));
  fs.mkdirSync(path.join(root, "resources"), { recursive: true });
  writeSyntheticElf(path.join(root, PRODUCT_BINARY_NAME));
  fs.writeFileSync(path.join(root, "resources", "app.asar"), "synthetic asar");
  fs.writeFileSync(path.join(root, "resources", "factory-desktop.png"), solidPng(512, 512));
  fs.writeFileSync(path.join(root, "factory-desktop-launcher"), '#!/usr/bin/env bash\nAPP_ROOT="$(pwd)"\nexec "$APP_ROOT/factory-desktop" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, "build-info.json"), JSON.stringify({ binaryName: PRODUCT_BINARY_NAME }));

  const result = assertPackagedRuntimeLayout(root);
  assert.equal(result.binaryName, "factory-desktop");
  assert.equal(result.iconPath, path.join(root, "resources", "factory-desktop.png"));
  assert.equal(fs.existsSync(path.join(root, "electron")), false);
});

test("runtime assembly carries the ASAR companion tree for unpacked native modules", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-runtime-unpacked-"));
  try {
    const source = path.join(root, "source");
    const sourceAsar = path.join(root, "app.asar");
    const zipRoot = path.join(root, "electron");
    fs.mkdirSync(path.join(source, ".vite", "build"), { recursive: true });
    fs.writeFileSync(path.join(source, ".vite", "build", "index.js"), "module.exports = {};\n");
    fs.mkdirSync(path.join(source, "native"), { recursive: true });
    fs.writeFileSync(path.join(source, "native", "keytar.node"), "native-module");
    const asar = require(require.resolve("@electron/asar", { paths: [path.resolve(__dirname, "..", "patcher")] }));
    await asar.createPackageWithOptions(source, sourceAsar, { unpack: path.join(source, "native", "keytar.node") });
    fs.mkdirSync(zipRoot, { recursive: true });
    const electron = path.join(zipRoot, "electron");
    fs.writeFileSync(electron, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("synthetic")]), { mode: 0o755 });
    const zipPath = path.join(root, "electron.zip");
    execFileSync("7z", ["a", "-tzip", zipPath, "electron"], { cwd: zipRoot, stdio: "ignore" });
    const icon = path.join(root, "factory.icns");
    fs.writeFileSync(icon, icnsWithPng("ic09", solidPng(512, 512)));
    const outputDir = path.join(root, "app");

    await assembleRuntimeAsync({
      extracted: { electronVersion: "42.3.3", appAsarPath: sourceAsar, appAsarUnpackedPath: `${sourceAsar}.unpacked`, iconPath: icon },
      outputDir,
      zipPath,
      sourceAsar,
    });

    assert.equal(fs.readFileSync(path.join(outputDir, "resources", "app.asar.unpacked", "native", "keytar.node"), "utf8"), "native-module");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime rejects a missing Linux application icon", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-packaged-no-icon-"));
  fs.mkdirSync(path.join(root, "resources"), { recursive: true });
  writeSyntheticElf(path.join(root, PRODUCT_BINARY_NAME));
  fs.writeFileSync(path.join(root, "resources", "app.asar"), "synthetic asar");
  fs.writeFileSync(path.join(root, "factory-desktop-launcher"), '#!/usr/bin/env bash\nAPP_ROOT="$(pwd)"\nexec "$APP_ROOT/factory-desktop" "$@"\n', { mode: 0o755 });

  assert.throws(() => assertPackagedRuntimeLayout(root), /factory-desktop\.png|icon/i);
});

test("packaged runtime rejects the Electron development binary name", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-dev-layout-"));
  fs.mkdirSync(path.join(root, "resources"), { recursive: true });
  writeSyntheticElf(path.join(root, "electron"));
  fs.writeFileSync(path.join(root, "resources", "app.asar"), "synthetic asar");
  assert.throws(() => assertPackagedRuntimeLayout(root), /product binary is missing|must not retain the electron binary name/);
});

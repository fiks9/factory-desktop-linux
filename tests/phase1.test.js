"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { test, before, after } = require("node:test");
const {
  parseVersion,
  parseVersionFromUrl,
  discoverLatestVersion,
  streamToContentAddressed,
  cachePinnedDmg,
} = require("../scripts/dmg");
const { plistValue, validateDmgFile } = require("../scripts/extract-dmg");
const { execFileSync } = require("node:child_process");
const { assertNoBundledDroid, assertAcceptedPatchReport } = require("../scripts/package-deb");

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

#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { patchAsar } = require("../../patcher/src/engine");
const { listJavaScriptFiles, readFile } = require("../../patcher/src/asar-io");
const { buildApp } = require("../../scripts/build-app");
const { buildDeb } = require("../../scripts/package-deb");
const { buildRpm } = require("../../scripts/package-rpm");
const { buildAppImage } = require("../../scripts/package-appimage");
const { inspectPackage } = require("../../scripts/inspect-package");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));

async function materialize(entry, sourcePath, root) {
  if (sourcePath.endsWith(".asar")) {
    const target = path.join(root, `Factory-${entry.version}.asar`);
    fs.copyFileSync(sourcePath, target);
    return target;
  }
  const extractDir = path.join(root, `dmg-${entry.version}`);
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync(process.env.SEVEN_ZIP || "7z", ["x", "-y", `-o${extractDir}`, sourcePath, "Factory/Factory.app/Contents/Resources/app.asar"], { stdio: "ignore", timeout: 10 * 60 * 1000 });
  return path.join(extractDir, "Factory", "Factory.app", "Contents", "Resources", "app.asar");
}

(async () => {
  const harnessRoot = process.env.FACTORY_TEST_TMP_ROOT;
  if (!harnessRoot || !path.isAbsolute(harnessRoot)) throw new Error("FACTORY_TEST_TMP_ROOT must be an absolute controlled temporary directory");
  fs.mkdirSync(harnessRoot, { recursive: true });
  let exercised = 0;
  for (const entry of manifest.fixtures) {
    const sourcePath = entry.paths.find((candidate) => fs.existsSync(candidate));
    if (!sourcePath) {
      console.log(`${entry.version}: SKIP (local fixture unavailable)`);
      continue;
    }
    const root = path.join(harnessRoot, entry.version);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const asarPath = await materialize(entry, sourcePath, root);
    const before = listJavaScriptFiles(asarPath).some((file) => readFile(asarPath, file).includes("/* factory-linux:"));
    if (entry.negative_fixture && before) throw new Error(`${entry.version}: foreign fixture unexpectedly contains our markers`);
    try {
      const report = await patchAsar({ asarPath, reportPath: path.join(root, "patch-report.json") });
      const transport = report.outcomes.find((outcome) => outcome.id === "daemon-transport-force-websocket");
      if (entry.negative_fixture && transport.alreadyPatched) throw new Error(`${entry.version}: foreign patch was accepted as our patch`);
      if (!report.outcomes.every((outcome) => outcome.validationPassed)) throw new Error(`${entry.version}: validator failure`);
      const second = await patchAsar({ asarPath, reportPath: path.join(root, "patch-report-second.json") });
      if (second.changed || !second.outcomes.every((outcome) => outcome.alreadyPatched && outcome.validationPassed)) {
        throw new Error(`${entry.version}: second patch run was not idempotent`);
      }
      console.log(`${entry.version}: PASS (${entry.transport_shape}, ${transport.patched ? "patched" : "validated"})`);
      if (!entry.negative_fixture && sourcePath.endsWith(".dmg")) {
        const built = await buildApp({ dmg: sourcePath, version: entry.version, cacheDir: path.join(root, "downloads"), workDir: path.join(root, "work") });
        const dist = path.join(root, "dist");
        const artifacts = [
          buildDeb({ appDir: built.appDir, version: entry.version, outputDir: dist }),
          buildRpm({ appDir: built.appDir, version: entry.version, outputDir: dist }),
          await buildAppImage({ appDir: built.appDir, version: entry.version, outputDir: dist, cacheDir: path.join(root, "appimage-cache") }),
        ];
        for (const artifact of artifacts) {
          const inspected = inspectPackage(artifact.path);
          console.log(`${entry.version}: ${inspected.format} PASS ${artifact.sha256} ${artifact.bytes}`);
        }
      }
    } catch (error) {
      if (!entry.negative_fixture) throw error;
      console.log(`${entry.version}: PASS negative fixture failed closed (${error.message})`);
    }
    exercised++;
  }
  if (exercised === 0) throw new Error("No local real-bundle fixtures were available");
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { acquireDmg } = require("./dmg");
const { extractDmg } = require("./extract-dmg");
const { assembleRuntime, assertPackagedRuntimeLayout } = require("./runtime");
const { patchAsar } = require("../patcher/src/engine");

async function buildApp(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, ".."));
  const work = path.resolve(options.workDir || path.join(root, "work"));
  const downloads = path.resolve(options.cacheDir || path.join(root, "downloads"));
  const candidate = path.join(work, `candidate-${process.pid}`);
  fs.rmSync(candidate, { recursive: true, force: true });
  fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const dmg = await acquireDmg({
    pinnedPath: options.dmg,
    cacheDir: downloads,
    arch: options.arch || "x64",
    version: options.version,
  });
  const extracted = extractDmg(dmg.path, path.join(candidate, "extracted"), {
    expectedSha256: dmg.sha256,
    expectedVersion: options.version || dmg.version || undefined,
  });
  const patchReportPath = path.join(candidate, "patch-report.json");
  let patchReport;
  let patchedAsarPath = options.patchedAsarPath;
  if (!patchedAsarPath) {
    patchReport = await patchAsar({ asarPath: extracted.appAsarPath, reportPath: patchReportPath });
    patchedAsarPath = extracted.appAsarPath;
  }
  const runtime = await assembleRuntime({
    extracted,
    patchedAsarPath,
    outputDir: path.join(candidate, "app"),
    cacheDir: path.join(root, ".cache", "electron"),
  });
  const buildInfo = {
    phase: 2,
    source: dmg.source,
    dmgFile: path.basename(dmg.path),
    dmgSha256: dmg.sha256,
    factoryVersion: extracted.version,
    electronVersion: extracted.electronVersion,
    binaryName: runtime.binaryName,
    launcherName: runtime.launcherName,
    sourceAsarSha256: extracted.appAsarSha256,
    runtimeAsarSha256: runtime.appAsarSha256,
    patchHook: options.patchedAsarPath ? "external" : "phase2-engine",
    patchReportPath: options.patchedAsarPath ? null : ".factory-linux/patch-report.json",
  };
  const metadataDir = path.join(runtime.outputDir, ".factory-linux");
  fs.mkdirSync(metadataDir, { recursive: true });
  if (patchReport) {
    fs.copyFileSync(patchReportPath, path.join(metadataDir, "patch-report.json"));
  }
  fs.writeFileSync(path.join(runtime.outputDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
  assertPackagedRuntimeLayout(runtime.outputDir, { binaryName: runtime.binaryName });
  return { dmg, extracted, runtime, buildInfo, appDir: runtime.outputDir };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  buildApp({ dmg: get("--dmg"), version: get("--version") }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(`Build failed: ${error.message}`); process.exit(1); });
}

module.exports = { buildApp };

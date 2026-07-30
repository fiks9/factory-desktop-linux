"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { acquireDmg } = require("./dmg");
const { extractDmg } = require("./extract-dmg");
const { assembleRuntime, assertPackagedRuntimeLayout } = require("./runtime");
const { patchAsar } = require("../patcher/src/engine");
const { sha256File } = require("./dmg");
const { buildEnvironment, validateBuildInfo } = require("./release-metadata");

async function buildApp(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, ".."));
  const work = path.resolve(options.workDir || path.join(root, "work"));
  const downloads = path.resolve(options.cacheDir || path.join(root, "downloads"));
  const candidate = path.join(work, `candidate-${process.pid}`);
  fs.rmSync(candidate, { recursive: true, force: true });
  fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const dmg = options.acquiredDmg || await acquireDmg({
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
    cacheDir: options.electronCacheDir || path.join(root, ".cache", "electron"),
  });
  const buildInfo = {
    schemaVersion: 2,
    phase: 6,
    source: dmg.source,
    dmgFile: path.basename(dmg.path),
    dmgSha256: dmg.sha256,
    factoryVersion: extracted.version,
    wrapperRevision: options.wrapperRevision ?? null,
    electronVersion: extracted.electronVersion,
    binaryName: runtime.binaryName,
    launcherName: runtime.launcherName,
    patcherVersion: require("../patcher/package.json").version,
    rawAsarSha256: extracted.appAsarSha256,
    patchedAsarSha256: runtime.appAsarSha256,
    patchReportSha256: patchReport ? sha256File(patchReportPath) : null,
    patchHook: options.patchedAsarPath ? "external" : "phase2-engine",
    patchReportPath: options.patchedAsarPath ? null : ".factory-linux/patch-report.json",
    ...buildEnvironment(root),
  };
  buildInfo.patcherCommit = buildInfo.repositoryCommit;
  const metadataDir = path.join(runtime.outputDir, ".factory-linux");
  fs.mkdirSync(metadataDir, { recursive: true });
  if (patchReport) {
    fs.copyFileSync(patchReportPath, path.join(metadataDir, "patch-report.json"));
    validateBuildInfo(buildInfo, { requirePackage: false });
  }
  fs.writeFileSync(path.join(runtime.outputDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
  assertPackagedRuntimeLayout(runtime.outputDir, { binaryName: runtime.binaryName });
  return { dmg, extracted, runtime, patchReport, buildInfo, appDir: runtime.outputDir };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  buildApp({ dmg: get("--dmg"), version: get("--version"), wrapperRevision: get("--wrapper-revision"), root: get("--root"), workDir: get("--work-dir"), cacheDir: get("--cache-dir"), electronCacheDir: get("--electron-cache-dir") }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(`Build failed: ${error.message}`); process.exit(1); });
}

module.exports = { buildApp };

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { acquireDmg } = require("./dmg");
const { extractDmg } = require("./extract-dmg");
const { assembleRuntime } = require("./runtime");

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
  // Phase 2 injects its output through this explicit hook. Phase 1 copies the
  // upstream ASAR unchanged and records the exact input/output identity.
  const patchedAsarPath = options.patchedAsarPath || extracted.appAsarPath;
  const runtime = await assembleRuntime({
    extracted,
    patchedAsarPath,
    outputDir: path.join(candidate, "app"),
    cacheDir: path.join(root, ".cache", "electron"),
  });
  const buildInfo = {
    phase: 1,
    source: dmg.source,
    dmgPath: dmg.path,
    dmgSha256: dmg.sha256,
    factoryVersion: extracted.version,
    electronVersion: extracted.electronVersion,
    sourceAsarSha256: extracted.appAsarSha256,
    runtimeAsarSha256: runtime.appAsarSha256,
    patchHook: options.patchedAsarPath ? "external" : "phase1-identity",
  };
  fs.writeFileSync(path.join(runtime.outputDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
  return { dmg, extracted, runtime, buildInfo, appDir: runtime.outputDir };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  buildApp({ dmg: get("--dmg"), version: get("--version") }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(`Build failed: ${error.message}`); process.exit(1); });
}

module.exports = { buildApp };

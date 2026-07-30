#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildApp } = require("./build-app");
const { parseVersion, sha256File } = require("./dmg");
const { inspectPackage } = require("./inspect-package");
const { buildAppImage } = require("./package-appimage");
const { buildDeb } = require("./package-deb");
const { buildRpm } = require("./package-rpm");
const {
  createReleaseManifest,
  validateBuildInfo,
  validateReleaseManifest,
  verifyReleaseBundle,
  writeChecksums,
} = require("./release-metadata");
const { acquireCachedOfficialDmg, writeVersionIndex } = require("./upstream-watch");
const { writePatchDriftArtifacts } = require("./patch-diagnostics");

function requireEmptyOutput(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  if (fs.readdirSync(directory).length) throw new Error(`Release output must be empty: ${directory}`);
}

function acceptanceSummary(source, patchReport, artifacts) {
  const requiredPatches = patchReport.outcomes.map((outcome) => ({
    id: outcome.id,
    accepted: Boolean((outcome.matched || outcome.alreadyPatched) && outcome.validationPassed),
    matcherClass: outcome.evidence?.matcher || outcome.matchStrategy || "validator",
  }));
  if (requiredPatches.some((entry) => !entry.accepted)) throw new Error("Acceptance summary contains a rejected patch");
  return {
    schemaVersion: 1,
    verdict: "accepted",
    factoryVersion: source.factoryVersion,
    sourceDmgSha256: source.dmgSha256,
    rawAsarSha256: source.rawAsarSha256,
    patchedAsarSha256: source.patchedAsarSha256,
    patcherVersion: source.patcherVersion,
    patcherCommit: source.patcherCommit,
    electronVersion: source.electronVersion,
    buildTimestamp: source.buildTimestamp,
    requiredPatches,
    packages: artifacts.map((artifact) => ({
      filename: path.basename(artifact.path),
      format: artifact.inspection.format,
      inspected: true,
      packageSha256: artifact.inspection.packageSha256,
    })).sort((left, right) => left.format.localeCompare(right.format)),
  };
}

async function buildRelease(options) {
  const version = parseVersion(options.version);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-release-build-"));
  const outputDir = path.resolve(options.outputDir);
  requireEmptyOutput(outputDir);
  try {
    const cacheDir = path.resolve(options.cacheDir || path.join(process.cwd(), ".cache", "release-downloads"));
    const acquiredDmg = await acquireCachedOfficialDmg(version, cacheDir);
    let built;
    try {
      built = await buildApp({
        acquiredDmg,
        version,
        workDir: path.join(root, "work"),
        cacheDir,
        electronCacheDir: path.resolve(options.electronCacheDir || path.join(process.cwd(), ".cache", "electron")),
      });
    } catch (error) {
      if (error.report) {
        writeVersionIndex(cacheDir, version, acquiredDmg.sha256);
        writePatchDriftArtifacts(path.join(outputDir, "diagnostics"), {
          factoryVersion: version,
          rawAsarSha256: error.report.originalHash,
          report: error.report,
          excerpts: error.excerpts || [],
        });
      }
      throw error;
    }
    writeVersionIndex(cacheDir, version, acquiredDmg.sha256);
    const temporaryDist = path.join(root, "dist");
    const packageResults = [
      buildDeb({ appDir: built.appDir, version, outputDir: temporaryDist }),
      buildRpm({ appDir: built.appDir, version, outputDir: temporaryDist }),
      await buildAppImage({
        appDir: built.appDir,
        version,
        outputDir: temporaryDist,
        cacheDir: path.resolve(options.appImageCacheDir || path.join(process.cwd(), ".cache", "appimage")),
      }),
    ];
    const artifacts = packageResults.map((artifact) => ({ ...artifact, inspection: inspectPackage(artifact.path) }));
    const source = JSON.parse(fs.readFileSync(path.join(built.appDir, "build-info.json"), "utf8"));
    validateBuildInfo(source, { requirePackage: false });
    const manifest = createReleaseManifest(source, artifacts);
    validateReleaseManifest(manifest);

    const patchReport = built.patchReport;
    if (!patchReport || sha256File(path.join(built.appDir, ".factory-linux", "patch-report.json")) !== source.patchReportSha256) {
      throw new Error("Release patch report does not match source provenance");
    }
    const summary = acceptanceSummary(source, patchReport, artifacts);
    for (const artifact of artifacts) fs.copyFileSync(artifact.path, path.join(outputDir, path.basename(artifact.path)));
    const patchReportPath = path.join(outputDir, "patch-report.json");
    const buildInfoPath = path.join(outputDir, "build-info.json");
    const summaryPath = path.join(outputDir, "acceptance-summary.json");
    fs.writeFileSync(patchReportPath, `${JSON.stringify(patchReport, null, 2)}\n`);
    if (sha256File(patchReportPath) !== source.patchReportSha256) {
      throw new Error("Release patch-report asset does not match source provenance");
    }
    fs.writeFileSync(buildInfoPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    const releaseFiles = [
      ...artifacts.map((artifact) => path.join(outputDir, path.basename(artifact.path))),
      buildInfoPath,
      patchReportPath,
      summaryPath,
    ];
    const checksumsPath = path.join(outputDir, "checksums.txt");
    writeChecksums(checksumsPath, releaseFiles);
    verifyReleaseBundle(outputDir, {
      factoryVersion: source.factoryVersion,
      repositoryCommit: source.repositoryCommit,
    });
    return { outputDir, artifacts, manifest, summary, checksumsPath };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const version = value("--version");
  const outputDir = value("--output-dir");
  if (!version || !outputDir) {
    console.error("Usage: node scripts/release-build.js --version 0.140.0 --output-dir /absolute/output");
    process.exit(2);
  }
  buildRelease({ version, outputDir, cacheDir: value("--cache-dir") })
    .then((result) => console.log(JSON.stringify({ verdict: "accepted", outputDir: result.outputDir }, null, 2)))
    .catch((error) => { console.error(`Release build failed: ${error.message}`); process.exit(1); });
}

module.exports = { acceptanceSummary, buildRelease, requireEmptyOutput };

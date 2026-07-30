#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { inspectPackage } = require("./inspect-package");
const { acceptanceSummary } = require("./release-build");
const {
  createReleaseManifest,
  verifyReleaseBundle,
  writeChecksums,
} = require("./release-metadata");

const ROOT = path.resolve(__dirname, "..");
const PROPRIETARY_EXTENSIONS = [".dmg", ".asar", ".deb", ".rpm", ".AppImage"];

function gitStatus() {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  });
}

function assertNoTrackedGeneratedArtifacts() {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const forbidden = files.filter((file) => PROPRIETARY_EXTENSIONS.some((extension) => file.endsWith(extension)));
  if (forbidden.length) throw new Error(`Generated/proprietary artifacts are tracked: ${forbidden.join(", ")}`);
}

function runMake(args) {
  execFileSync("make", args, { cwd: ROOT, stdio: "inherit", env: process.env });
}

function verifySyntheticReleaseBundle(dist) {
  const packageFiles = fs.readdirSync(dist)
    .filter((name) => name.endsWith(".deb") || name.endsWith(".rpm") || name.endsWith(".AppImage"))
    .map((name) => path.join(dist, name));
  const artifacts = packageFiles.map((artifactPath) => ({ path: artifactPath, inspection: inspectPackage(artifactPath) }));
  const first = artifacts[0]?.inspection;
  if (!first) throw new Error("Synthetic release gate produced no packages");
  const { packageFormat: _packageFormat, nativePackage: _nativePackage, ...source } = first.buildInfo;
  for (const artifact of artifacts) {
    const { packageFormat, nativePackage, ...candidateSource } = artifact.inspection.buildInfo;
    if (JSON.stringify(candidateSource) !== JSON.stringify(source)) throw new Error("Package source provenance differs across formats");
    if (packageFormat !== artifact.inspection.format || nativePackage !== (packageFormat !== "appimage")) {
      throw new Error("Package-specific provenance does not match inspection");
    }
  }
  const manifest = createReleaseManifest(source, artifacts);
  const report = first.patchReport;
  const summary = acceptanceSummary(source, report, artifacts);
  const metadataFiles = [
    ["build-info.json", manifest],
    ["patch-report.json", report],
    ["acceptance-summary.json", summary],
  ].map(([name, value]) => {
    const file = path.join(dist, name);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
  });
  const checksums = path.join(dist, "checksums.txt");
  writeChecksums(checksums, [...packageFiles, ...metadataFiles]);
  verifyReleaseBundle(dist, {
    factoryVersion: source.factoryVersion,
    repositoryCommit: source.repositoryCommit,
  });
}

function main() {
  const before = gitStatus();
  if (process.env.FACTORY_REQUIRE_CLEAN_GIT === "1" && before) throw new Error("Release checkout is not clean");
  assertNoTrackedGeneratedArtifacts();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "factory-release-check-"));
  try {
    runMake(["check"]);
    runMake(["test"]);
    const dist = path.join(temporary, "dist");
    runMake(["package-smoke", "VERSION=0.139.0", `DIST_DIR=${dist}`]);
    verifySyntheticReleaseBundle(dist);
    runMake(["test-real-bundles"]);
    execFileSync("git", ["diff", "--check"], { cwd: ROOT, stdio: "inherit" });
    assertNoTrackedGeneratedArtifacts();
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  const after = gitStatus();
  if (after !== before) throw new Error("release-check changed the source tree or left generated artifacts");
  process.stdout.write("Release gate passed without changing the source tree.\n");
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`Release gate failed: ${error.message}`); process.exit(1); }
}

module.exports = { assertNoTrackedGeneratedArtifacts, gitStatus, verifySyntheticReleaseBundle };

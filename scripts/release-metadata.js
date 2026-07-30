#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { sha256File } = require("./dmg");

const FORMATS = new Set(["deb", "rpm", "appimage"]);
const SOURCE_FIELDS = [
  "factoryVersion", "electronVersion", "dmgSha256", "rawAsarSha256",
  "patchedAsarSha256", "patchReportSha256", "binaryName",
  "patcherVersion", "patcherCommit", "repositoryCommit", "workflowRunId",
  "buildTimestamp", "targetArchitecture",
];

function assertDigest(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} SHA-256 is invalid`);
  }
}

function repositoryCommit(root = path.resolve(__dirname, "..")) {
  const fromEnvironment = process.env.FACTORY_REPOSITORY_COMMIT;
  if (fromEnvironment && /^[a-f0-9]{40}$/.test(fromEnvironment)) return fromEnvironment;
  const value = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("Repository commit is not a full Git SHA");
  return value;
}

function buildEnvironment(root) {
  return {
    repositoryCommit: repositoryCommit(root),
    workflowRunId: String(process.env.GITHUB_RUN_ID || "local"),
    buildTimestamp: new Date().toISOString(),
    targetArchitecture: "x86_64",
  };
}

function validateBuildInfo(info, options = {}) {
  if (!info || typeof info !== "object" || Array.isArray(info) || info.schemaVersion !== 2) {
    throw new Error("build-info schemaVersion must be 2");
  }
  for (const field of SOURCE_FIELDS) {
    if (typeof info[field] !== "string" || !info[field]) throw new Error(`build-info ${field} is missing`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(info.factoryVersion)) throw new Error("build-info Factory version is invalid");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(info.electronVersion)) throw new Error("build-info Electron version is invalid");
  for (const field of ["dmgSha256", "rawAsarSha256", "patchedAsarSha256", "patchReportSha256"]) assertDigest(info[field], field);
  if (info.binaryName !== "factory-desktop") throw new Error("build-info binary name is invalid");
  if (!/^[0-9A-Za-z.+-]+$/.test(info.patcherVersion)) throw new Error("build-info patcher version is invalid");
  if (!/^[a-f0-9]{40}$/.test(info.patcherCommit)) throw new Error("build-info patcher commit is invalid");
  if (!/^[a-f0-9]{40}$/.test(info.repositoryCommit)) throw new Error("build-info repository commit is invalid");
  if (info.workflowRunId !== "local" && !/^\d+$/.test(info.workflowRunId)) throw new Error("build-info workflow run ID is invalid");
  if (!Number.isFinite(Date.parse(info.buildTimestamp))) throw new Error("build-info timestamp is invalid");
  if (info.targetArchitecture !== "x86_64") throw new Error("build-info target architecture is invalid");
  const requirePackage = options.requirePackage !== false;
  if (requirePackage) {
    if (!FORMATS.has(info.packageFormat)) throw new Error("build-info package format is invalid");
    const expectedNative = info.packageFormat !== "appimage";
    if (info.nativePackage !== expectedNative) throw new Error("build-info native package identity is invalid");
  }
  if (options.expectedFormat && info.packageFormat !== options.expectedFormat) {
    throw new Error(`build-info format mismatch: expected ${options.expectedFormat}, got ${info.packageFormat}`);
  }
  return info;
}

function withPackageIdentity(sourceInfo, format) {
  validateBuildInfo(sourceInfo, { requirePackage: false });
  if (!FORMATS.has(format)) throw new Error(`Unsupported package format: ${format}`);
  const result = { ...sourceInfo, packageFormat: format, nativePackage: format !== "appimage" };
  validateBuildInfo(result, { expectedFormat: format });
  return result;
}

function writePackageBuildInfo(appDir, format) {
  const file = path.join(appDir, "build-info.json");
  const source = JSON.parse(fs.readFileSync(file, "utf8"));
  const result = withPackageIdentity(source, format);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });
  return result;
}

function exactBasenames(files) {
  const names = files.map((file) => path.basename(file));
  if (new Set(names).size !== names.length) throw new Error("Release artifact filenames must be unique");
  if (names.some((name) => /(?:^|[-_.])(latest|stable)(?:[-_.]|$)/i.test(name))) {
    throw new Error("Release artifacts must use exact versioned filenames, not latest/stable aliases");
  }
  return names.sort();
}

function writeChecksums(destination, files) {
  const names = exactBasenames(files);
  const byName = new Map(files.map((file) => [path.basename(file), file]));
  const lines = names.map((name) => `${sha256File(byName.get(name))}  ${name}`);
  fs.writeFileSync(destination, `${lines.join("\n")}\n`, { mode: 0o644 });
  return lines;
}

function verifyChecksums(checksumFile, files) {
  const expectedNames = exactBasenames(files);
  const lines = fs.readFileSync(checksumFile, "utf8").trim().split("\n").filter(Boolean);
  const entries = lines.map((line) => {
    const match = line.match(/^([a-f0-9]{64})  ([^/]+)$/);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    return { sha256: match[1], filename: match[2] };
  });
  const actualNames = entries.map((entry) => entry.filename).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("checksums.txt does not cover the exact filenames");
  }
  const byName = new Map(files.map((file) => [path.basename(file), file]));
  for (const entry of entries) {
    if (sha256File(byName.get(entry.filename)) !== entry.sha256) {
      throw new Error(`Checksum mismatch for ${entry.filename}`);
    }
  }
  return entries.sort((left, right) => left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0);
}

function createReleaseManifest(sourceInfo, artifacts) {
  validateBuildInfo(sourceInfo, { requirePackage: false });
  const packages = artifacts.map(({ path: artifactPath, inspection }) => {
    if (!inspection || !FORMATS.has(inspection.format)) throw new Error("Package inspection format is missing");
    if (inspection.packageName !== "factory-desktop" || inspection.version !== sourceInfo.factoryVersion) {
      throw new Error("Package inspection identity does not match source provenance");
    }
    validateBuildInfo(inspection.buildInfo, { expectedFormat: inspection.format });
    for (const [field, expected] of Object.entries(sourceInfo)) {
      if (JSON.stringify(inspection.buildInfo[field]) !== JSON.stringify(expected)) {
        throw new Error(`Package ${inspection.format} embedded provenance mismatch for ${field}`);
      }
    }
    return {
      filename: path.basename(artifactPath),
      format: inspection.format,
      nativePackage: inspection.format !== "appimage",
      sha256: sha256File(artifactPath),
      bytes: fs.statSync(artifactPath).size,
    };
  }).sort((left, right) => left.format.localeCompare(right.format));
  const manifest = { ...sourceInfo, packages };
  validateReleaseManifest(manifest);
  return manifest;
}

function validateReleaseManifest(manifest) {
  validateBuildInfo(manifest, { requirePackage: false });
  if (!Array.isArray(manifest.packages)) throw new Error("Release package list is missing");
  const formats = manifest.packages.map((entry) => entry.format).sort();
  if (JSON.stringify(formats) !== JSON.stringify(["appimage", "deb", "rpm"])) {
    throw new Error("Release manifest must contain exact deb/rpm/AppImage formats");
  }
  for (const entry of manifest.packages) {
    if (path.basename(entry.filename) !== entry.filename) throw new Error("Release filename escaped its directory");
    assertDigest(entry.sha256, `${entry.format} package`);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) throw new Error("Release package size is invalid");
    if (entry.nativePackage !== (entry.format !== "appimage")) throw new Error("Release native package identity is invalid");
  }
  return manifest;
}

function validateReleaseContext(manifest, expected) {
  validateReleaseManifest(manifest);
  if (manifest.factoryVersion !== expected.factoryVersion) {
    throw new Error(`Release Factory version mismatch: expected ${expected.factoryVersion}, got ${manifest.factoryVersion}`);
  }
  if (manifest.repositoryCommit !== expected.repositoryCommit) {
    throw new Error(`Release repository commit mismatch: expected ${expected.repositoryCommit}, got ${manifest.repositoryCommit}`);
  }
  const expectedNames = {
    appimage: `Factory-${expected.factoryVersion}-x86_64.AppImage`,
    deb: `factory-desktop_${expected.factoryVersion}_amd64.deb`,
    rpm: `factory-desktop-${expected.factoryVersion}-1.x86_64.rpm`,
  };
  for (const entry of manifest.packages) {
    if (entry.filename !== expectedNames[entry.format]) {
      throw new Error(`Release ${entry.format} filename mismatch: expected ${expectedNames[entry.format]}, got ${entry.filename}`);
    }
  }
  return manifest;
}

function readJson(file, name) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Release ${name} is invalid JSON: ${error.message}`);
  }
  return value;
}

function verifyReleaseBundle(directory, expected) {
  const root = path.resolve(directory);
  const manifestPath = path.join(root, "build-info.json");
  const reportPath = path.join(root, "patch-report.json");
  const summaryPath = path.join(root, "acceptance-summary.json");
  const checksumsPath = path.join(root, "checksums.txt");
  const manifest = readJson(manifestPath, "build-info.json");
  validateReleaseContext(manifest, expected);
  const expectedAssets = [
    ...manifest.packages.map((entry) => entry.filename),
    "acceptance-summary.json",
    "build-info.json",
    "checksums.txt",
    "patch-report.json",
  ].sort();
  const entries = fs.readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) throw new Error("Release bundle contains a non-file entry");
  const actualAssets = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets)) {
    throw new Error("Release bundle does not contain the exact expected assets");
  }
  const checksummed = actualAssets.filter((name) => name !== "checksums.txt").map((name) => path.join(root, name));
  verifyChecksums(checksumsPath, checksummed);
  for (const entry of manifest.packages) {
    const packagePath = path.join(root, entry.filename);
    if (sha256File(packagePath) !== entry.sha256) throw new Error(`Release manifest hash mismatch for ${entry.filename}`);
    if (fs.statSync(packagePath).size !== entry.bytes) throw new Error(`Release manifest size mismatch for ${entry.filename}`);
  }
  if (sha256File(reportPath) !== manifest.patchReportSha256) throw new Error("Release patch-report hash mismatch");
  const report = readJson(reportPath, "patch-report.json");
  if (report.originalHash !== manifest.rawAsarSha256 || report.finalHash !== manifest.patchedAsarSha256) {
    throw new Error("Release patch-report ASAR hashes do not match provenance");
  }
  const summary = readJson(summaryPath, "acceptance-summary.json");
  const summaryFields = {
    factoryVersion: manifest.factoryVersion,
    sourceDmgSha256: manifest.dmgSha256,
    rawAsarSha256: manifest.rawAsarSha256,
    patchedAsarSha256: manifest.patchedAsarSha256,
    patcherVersion: manifest.patcherVersion,
    patcherCommit: manifest.patcherCommit,
    electronVersion: manifest.electronVersion,
    buildTimestamp: manifest.buildTimestamp,
  };
  if (summary.schemaVersion !== 1 || summary.verdict !== "accepted") throw new Error("Release acceptance summary verdict is invalid");
  for (const [field, value] of Object.entries(summaryFields)) {
    if (summary[field] !== value) throw new Error(`Release acceptance summary mismatch for ${field}`);
  }
  if (!Array.isArray(report.outcomes) || report.outcomes.length === 0) throw new Error("Release patch report has no outcomes");
  const reportAcceptance = new Map(report.outcomes.map((outcome) => [
    outcome.id,
    Boolean((outcome.matched || outcome.alreadyPatched) && outcome.validationPassed),
  ]));
  if ([...reportAcceptance.values()].some((accepted) => !accepted)) throw new Error("Release patch report contains a rejected patch");
  if (!Array.isArray(summary.requiredPatches) || summary.requiredPatches.length !== reportAcceptance.size || summary.requiredPatches.some((entry) => !entry?.accepted)) {
    throw new Error("Release acceptance summary contains a rejected patch");
  }
  for (const entry of summary.requiredPatches) {
    if (reportAcceptance.get(entry.id) !== true) throw new Error(`Release acceptance summary patch mismatch for ${entry.id}`);
  }
  if (!Array.isArray(summary.packages) || summary.packages.length !== manifest.packages.length) {
    throw new Error("Release acceptance summary package list is invalid");
  }
  const summaryPackages = new Map(summary.packages.map((entry) => [entry.format, entry]));
  for (const entry of manifest.packages) {
    const accepted = summaryPackages.get(entry.format);
    if (!accepted || accepted.filename !== entry.filename || accepted.packageSha256 !== entry.sha256 || accepted.inspected !== true) {
      throw new Error(`Release acceptance summary package mismatch for ${entry.format}`);
    }
  }
  return { manifest, report, summary };
}

module.exports = {
  buildEnvironment,
  createReleaseManifest,
  repositoryCommit,
  validateBuildInfo,
  validateReleaseContext,
  validateReleaseManifest,
  verifyReleaseBundle,
  verifyChecksums,
  withPackageIdentity,
  writeChecksums,
  writePackageBuildInfo,
};

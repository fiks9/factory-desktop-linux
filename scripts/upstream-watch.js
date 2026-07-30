#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { acquireDmg, discoverLatestVersion, parseVersion, sha256File } = require("./dmg");
const { extractDmg } = require("./extract-dmg");
const { patchAsar } = require("../patcher/src/engine");
const { writePatchDriftArtifacts } = require("./patch-diagnostics");

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === b) return 0;
  const parts = (value) => value.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)(.*)$/).slice(1);
  const av = parts(a);
  const bv = parts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(av[index]) - Number(bv[index]);
    if (difference) return Math.sign(difference);
  }
  if (!av[3]) return 1;
  if (!bv[3]) return -1;
  return av[3].localeCompare(bv[3]);
}

function classifyVersion(latest, accepted) {
  latest = parseVersion(latest);
  accepted = parseVersion(accepted);
  const comparison = compareVersions(latest, accepted);
  return {
    status: comparison > 0 ? "new-version" : comparison < 0 ? "upstream-regression" : "current",
    latestVersion: latest,
    acceptedVersion: accepted,
  };
}

function readAcceptedVersion(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.schemaVersion !== 1) throw new Error("Accepted upstream schema is invalid");
  return parseVersion(value.acceptedVersion);
}

function indexPath(cacheDir) {
  return path.join(cacheDir, "version-index.json");
}

function readVersionIndex(cacheDir) {
  const file = indexPath(cacheDir);
  if (!fs.existsSync(file)) return { schemaVersion: 1, versions: {} };
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.schemaVersion !== 1 || !value.versions || typeof value.versions !== "object") {
    throw new Error("Upstream cache version index is invalid");
  }
  return value;
}

function reuseIndexedDmg(version, cacheDir) {
  version = parseVersion(version);
  const digest = readVersionIndex(cacheDir).versions[version];
  if (!digest) return null;
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Upstream cache index digest is invalid");
  const file = path.join(cacheDir, `Factory-${digest}.dmg`);
  const metadata = fs.statSync(file, { throwIfNoEntry: false });
  if (!metadata?.isFile()) return null;
  if (sha256File(file) !== digest) throw new Error(`Cached DMG hash mismatch for Factory ${version}`);
  return { path: file, sha256: digest, bytes: metadata.size, version, source: "official-cache" };
}

function writeVersionIndex(cacheDir, version, digest) {
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const value = readVersionIndex(cacheDir);
  value.versions[parseVersion(version)] = digest;
  const temporary = `${indexPath(cacheDir)}.${process.pid}.partial`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, indexPath(cacheDir));
}

async function acquireCachedOfficialDmg(version, cacheDir, options = {}) {
  const cached = reuseIndexedDmg(version, cacheDir);
  if (cached) return cached;
  const acquire = options.acquireDmg || acquireDmg;
  return acquire({ ...options, version, cacheDir });
}

async function probeVersion(options) {
  const version = parseVersion(options.version);
  const cacheDir = path.resolve(options.cacheDir);
  const root = fs.mkdtempSync(path.join(options.workRoot || os.tmpdir(), "factory-upstream-probe-"));
  try {
    const dmg = await acquireCachedOfficialDmg(version, cacheDir, options);
    let extracted;
    try {
      extracted = extractDmg(dmg.path, path.join(root, "extracted"), {
        expectedSha256: dmg.sha256,
        expectedVersion: version,
      });
    } catch (error) {
      error.category = "invalid-metadata";
      error.details = { factoryVersion: version, dmgSha256: dmg.sha256, dmgCacheSource: dmg.source };
      throw error;
    }
    writeVersionIndex(cacheDir, version, dmg.sha256);
    const reportPath = path.join(root, "patch-report.json");
    try {
      const report = await patchAsar({ asarPath: extracted.appAsarPath, reportPath });
      return {
        status: "accepted",
        factoryVersion: version,
        electronVersion: extracted.electronVersion,
        dmgSha256: dmg.sha256,
        dmgCacheSource: dmg.source,
        rawAsarSha256: extracted.appAsarSha256,
        patchedAsarSha256: report.finalHash,
        patchReport: report,
      };
    } catch (error) {
      if (error.report) {
        const artifacts = writePatchDriftArtifacts(path.resolve(options.diagnosticsDir), {
          factoryVersion: version,
          rawAsarSha256: extracted.appAsarSha256,
          report: error.report,
          excerpts: error.excerpts || [],
        });
        error.category = "patch-drift";
        error.diagnostic = artifacts.diagnostic;
      }
      error.details = {
        ...(error.details || {}),
        factoryVersion: version,
        dmgSha256: dmg.sha256,
        dmgCacheSource: dmg.source,
      };
      throw error;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function failureCategory(error) {
  if (error.category) return error.category;
  if (/HTTP\s+\d{3}|timed? out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|TLS|socket|network/i.test(error.message)) return "network-failure";
  if (/patch|validator|matcher/i.test(error.message)) return "patch-drift";
  if (/version|metadata|Info\.plist|DMG acceptance|Electron Framework|did not return JSON|Invalid Factory/i.test(error.message)) return "invalid-metadata";
  return "network-failure";
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const acceptedFile = path.resolve(value("--accepted-file", path.join(__dirname, "..", "release", "accepted-upstream.json")));
  const acceptedVersion = value("--accepted-version", readAcceptedVersion(acceptedFile));
  const outputFile = value("--output");
  const result = classifyVersion(await discoverLatestVersion(), acceptedVersion);
  if (args.includes("--probe") && result.status === "new-version") {
    result.probe = await probeVersion({
      version: result.latestVersion,
      cacheDir: value("--cache-dir", path.join(__dirname, "..", ".cache", "upstream-downloads")),
      diagnosticsDir: value("--diagnostics-dir", path.join(__dirname, "..", "diagnostics")),
    });
  }
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputFile) fs.writeFileSync(path.resolve(outputFile), json);
  process.stdout.write(json);
  if (result.status === "upstream-regression") process.exitCode = 1;
}

if (require.main === module) main().catch((error) => {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const result = {
    status: "failure",
    category: failureCategory(error),
    message: String(error.message).slice(0, 512),
    factoryVersion: error.details?.factoryVersion || null,
    dmgSha256: error.details?.dmgSha256 || null,
    dmgCacheSource: error.details?.dmgCacheSource || null,
    diagnostic: error.diagnostic || null,
  };
  if (outputIndex >= 0 && args[outputIndex + 1]) {
    fs.writeFileSync(path.resolve(args[outputIndex + 1]), `${JSON.stringify(result, null, 2)}\n`);
  }
  console.error(`Upstream watch failed: ${error.message}`);
  process.exit(1);
});

module.exports = {
  acquireCachedOfficialDmg,
  classifyVersion,
  compareVersions,
  failureCategory,
  probeVersion,
  readAcceptedVersion,
  readVersionIndex,
  reuseIndexedDmg,
  writeVersionIndex,
};

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-release-contract-"));
  const files = {
    deb: path.join(root, "factory-desktop_0.140.0_amd64.deb"),
    rpm: path.join(root, "factory-desktop-0.140.0-1.x86_64.rpm"),
    appimage: path.join(root, "Factory-0.140.0-x86_64.AppImage"),
    report: path.join(root, "patch-report.json"),
    summary: path.join(root, "acceptance-summary.json"),
  };
  for (const [name, file] of Object.entries(files)) fs.writeFileSync(file, `${name}\n`);
  return { root, files };
}

function sourceInfo() {
  return {
    schemaVersion: 2,
    factoryVersion: "0.140.0",
    electronVersion: "42.3.3",
    dmgSha256: "a".repeat(64),
    rawAsarSha256: "b".repeat(64),
    patchedAsarSha256: "c".repeat(64),
    patchReportSha256: "d".repeat(64),
    binaryName: "factory-desktop",
    patcherVersion: "0.0.0-phase2",
    patcherCommit: "1".repeat(40),
    repositoryCommit: "1".repeat(40),
    workflowRunId: "123456",
    buildTimestamp: "2026-07-30T12:00:00.000Z",
    targetArchitecture: "x86_64",
  };
}

test("upstream comparison accepts strict versions and only reports newer releases", () => {
  const { classifyVersion } = require("../scripts/upstream-watch");
  assert.deepEqual(classifyVersion("0.140.0", "0.139.0"), {
    status: "new-version",
    latestVersion: "0.140.0",
    acceptedVersion: "0.139.0",
  });
  assert.equal(classifyVersion("0.139.0", "0.139.0").status, "current");
  assert.equal(classifyVersion("0.138.0", "0.139.0").status, "upstream-regression");
  assert.throws(() => classifyVersion("latest", "0.139.0"), /Invalid Factory version/);
});

test("upstream watch reuses an indexed content-addressed DMG without download", async () => {
  const { sha256File } = require("../scripts/dmg");
  const { acquireCachedOfficialDmg, reuseIndexedDmg } = require("../scripts/upstream-watch");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-upstream-cache-"));
  try {
    const temporary = path.join(root, "source.dmg");
    fs.writeFileSync(temporary, "cached dmg");
    const digest = sha256File(temporary);
    const cached = path.join(root, `Factory-${digest}.dmg`);
    fs.renameSync(temporary, cached);
    fs.writeFileSync(path.join(root, "version-index.json"), `${JSON.stringify({ schemaVersion: 1, versions: { "0.139.0": digest } })}\n`);
    assert.deepEqual(reuseIndexedDmg("0.139.0", root), {
      path: cached,
      sha256: digest,
      bytes: fs.statSync(cached).size,
      version: "0.139.0",
      source: "official-cache",
    });
    let downloads = 0;
    const reused = await acquireCachedOfficialDmg("0.139.0", root, {
      acquireDmg: async () => { downloads += 1; throw new Error("download must not run"); },
    });
    assert.equal(reused.sha256, digest);
    assert.equal(downloads, 0);
    fs.writeFileSync(cached, "tampered");
    assert.throws(() => reuseIndexedDmg("0.139.0", root), /hash mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid exact-version DMG is never added to the accepted version index", async () => {
  const { sha256File } = require("../scripts/dmg");
  const { probeVersion, readVersionIndex } = require("../scripts/upstream-watch");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-upstream-invalid-acceptance-"));
  const cacheDir = path.join(root, "cache");
  try {
    await assert.rejects(probeVersion({
      version: "0.139.0",
      cacheDir,
      workRoot: root,
      diagnosticsDir: path.join(root, "diagnostics"),
      acquireDmg: async ({ version }) => {
        fs.mkdirSync(cacheDir, { recursive: true });
        const temporary = path.join(cacheDir, "invalid.dmg");
        fs.writeFileSync(temporary, "not a Factory DMG");
        const sha256 = sha256File(temporary);
        const destination = path.join(cacheDir, `Factory-${sha256}.dmg`);
        fs.renameSync(temporary, destination);
        return { path: destination, sha256, bytes: fs.statSync(destination).size, version, source: "official-versioned" };
      },
    }), /DMG|7z|archive|Can not open/i);
    assert.deepEqual(readVersionIndex(cacheDir), { schemaVersion: 1, versions: {} });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("upstream cache binds a version only after DMG acceptance", async () => {
  const { sha256File } = require("../scripts/dmg");
  const { acquireCachedOfficialDmg, reuseIndexedDmg, writeVersionIndex } = require("../scripts/upstream-watch");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-upstream-acceptance-cache-"));
  let downloads = 0;
  try {
    const acquireDmg = async ({ cacheDir, version }) => {
      downloads += 1;
      const temporary = path.join(cacheDir, `response-${downloads}.dmg`);
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(temporary, downloads === 1 ? "invalid response" : "accepted response");
      const sha256 = sha256File(temporary);
      const destination = path.join(cacheDir, `Factory-${sha256}.dmg`);
      fs.renameSync(temporary, destination);
      return { path: destination, sha256, bytes: fs.statSync(destination).size, version, source: "official" };
    };
    const rejected = await acquireCachedOfficialDmg("0.140.0", root, { acquireDmg });
    assert.equal(reuseIndexedDmg("0.140.0", root), null);
    const accepted = await acquireCachedOfficialDmg("0.140.0", root, { acquireDmg });
    assert.equal(downloads, 2);
    assert.notEqual(accepted.sha256, rejected.sha256);
    writeVersionIndex(root, "0.140.0", accepted.sha256);
    assert.equal(reuseIndexedDmg("0.140.0", root).sha256, accepted.sha256);
    await acquireCachedOfficialDmg("0.140.0", root, { acquireDmg });
    assert.equal(downloads, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source and package provenance are strict and format-bound", () => {
  const { validateBuildInfo, withPackageIdentity } = require("../scripts/release-metadata");
  const source = sourceInfo();
  assert.doesNotThrow(() => validateBuildInfo(source, { requirePackage: false }));
  const deb = withPackageIdentity(source, "deb");
  const appimage = withPackageIdentity(source, "appimage");
  assert.equal(deb.packageFormat, "deb");
  assert.equal(deb.nativePackage, true);
  assert.equal(appimage.nativePackage, false);
  assert.doesNotThrow(() => validateBuildInfo(deb, { expectedFormat: "deb" }));
  assert.throws(() => validateBuildInfo(deb, { expectedFormat: "rpm" }), /format/);
  assert.throws(() => validateBuildInfo({ ...source, dmgSha256: "not-a-hash" }, { requirePackage: false }), /SHA-256/);
});

test("checksums cover exact release filenames and reject aliases or drift", () => {
  const { writeChecksums, verifyChecksums } = require("../scripts/release-metadata");
  const { root, files } = fixture();
  try {
    const buildInfo = path.join(root, "build-info.json");
    fs.writeFileSync(buildInfo, `${JSON.stringify(sourceInfo())}\n`);
    const targets = [...Object.values(files), buildInfo];
    const checksumFile = path.join(root, "checksums.txt");
    writeChecksums(checksumFile, targets);
    const verified = verifyChecksums(checksumFile, targets);
    assert.deepEqual(verified.map((entry) => entry.filename), targets.map((file) => path.basename(file)).sort());
    fs.appendFileSync(checksumFile, `${"e".repeat(64)}  latest.deb\n`);
    assert.throws(() => verifyChecksums(checksumFile, targets), /exact filenames/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release manifest binds all inspected package formats to source provenance", () => {
  const { createReleaseManifest, validateReleaseContext, validateReleaseManifest } = require("../scripts/release-metadata");
  const { root, files } = fixture();
  try {
    const source = sourceInfo();
    const packageInfo = (format) => ({ ...source, packageFormat: format, nativePackage: format !== "appimage" });
    const manifest = createReleaseManifest(source, [
      { path: files.deb, inspection: { format: "deb", version: "0.140.0", packageName: "factory-desktop", buildInfo: packageInfo("deb") } },
      { path: files.rpm, inspection: { format: "rpm", version: "0.140.0", packageName: "factory-desktop", buildInfo: packageInfo("rpm") } },
      { path: files.appimage, inspection: { format: "appimage", version: "0.140.0", packageName: "factory-desktop", buildInfo: packageInfo("appimage") } },
    ]);
    assert.deepEqual(manifest.packages.map((entry) => entry.format), ["appimage", "deb", "rpm"]);
    assert.doesNotThrow(() => validateReleaseManifest(manifest));
    assert.doesNotThrow(() => validateReleaseContext(manifest, {
      factoryVersion: "0.140.0",
      repositoryCommit: "1".repeat(40),
    }));
    assert.throws(() => validateReleaseContext(manifest, {
      factoryVersion: "0.141.0",
      repositoryCommit: "1".repeat(40),
    }), /Factory version/);
    assert.throws(() => validateReleaseContext(manifest, {
      factoryVersion: "0.140.0",
      repositoryCommit: "2".repeat(40),
    }), /repository commit/);
    const renamed = structuredClone(manifest);
    renamed.packages[0].filename = "Factory-latest-x86_64.AppImage";
    assert.throws(() => validateReleaseContext(renamed, {
      factoryVersion: "0.140.0",
      repositoryCommit: "1".repeat(40),
    }), /filename/);
    assert.throws(() => validateReleaseManifest({ ...manifest, packages: manifest.packages.slice(1) }), /formats/);
    const mismatched = packageInfo("deb");
    mismatched.repositoryCommit = "2".repeat(40);
    assert.throws(() => createReleaseManifest(source, [
      { path: files.deb, inspection: { format: "deb", version: "0.140.0", packageName: "factory-desktop", buildInfo: mismatched } },
      { path: files.rpm, inspection: { format: "rpm", version: "0.140.0", packageName: "factory-desktop", buildInfo: packageInfo("rpm") } },
      { path: files.appimage, inspection: { format: "appimage", version: "0.140.0", packageName: "factory-desktop", buildInfo: packageInfo("appimage") } },
    ]), /embedded provenance/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release bundle verification binds manifest, files, patch report, and summary", () => {
  const { sha256File } = require("../scripts/dmg");
  const { verifyReleaseBundle, writeChecksums } = require("../scripts/release-metadata");
  const { root, files } = fixture();
  try {
    const source = sourceInfo();
    const packages = [
      ["deb", files.deb],
      ["rpm", files.rpm],
      ["appimage", files.appimage],
    ].map(([format, file]) => ({
      filename: path.basename(file),
      format,
      nativePackage: format !== "appimage",
      sha256: sha256File(file),
      bytes: fs.statSync(file).size,
    })).sort((left, right) => left.format.localeCompare(right.format));
    const report = {
      schemaVersion: 1,
      originalHash: source.rawAsarSha256,
      finalHash: source.patchedAsarSha256,
      outcomes: [{ id: "required-patch", matched: true, validationPassed: true }],
    };
    fs.writeFileSync(files.report, `${JSON.stringify(report, null, 2)}\n`);
    source.patchReportSha256 = sha256File(files.report);
    const manifest = { ...source, packages };
    const summary = {
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
      requiredPatches: [{ id: "required-patch", accepted: true, matcherClass: "fixture" }],
      packages: packages.map((entry) => ({ filename: entry.filename, format: entry.format, inspected: true, packageSha256: entry.sha256 })),
    };
    const buildInfo = path.join(root, "build-info.json");
    fs.writeFileSync(buildInfo, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(files.summary, `${JSON.stringify(summary, null, 2)}\n`);
    const releaseFiles = [...Object.values(files), buildInfo];
    writeChecksums(path.join(root, "checksums.txt"), releaseFiles);
    assert.doesNotThrow(() => verifyReleaseBundle(root, {
      factoryVersion: source.factoryVersion,
      repositoryCommit: source.repositoryCommit,
    }));
    manifest.packages[0].sha256 = "e".repeat(64);
    fs.writeFileSync(buildInfo, `${JSON.stringify(manifest, null, 2)}\n`);
    writeChecksums(path.join(root, "checksums.txt"), releaseFiles);
    assert.throws(() => verifyReleaseBundle(root, {
      factoryVersion: source.factoryVersion,
      repositoryCommit: source.repositoryCommit,
    }), /manifest hash/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("upstream failure categories distinguish transport from invalid metadata", () => {
  const { failureCategory } = require("../scripts/upstream-watch");
  assert.equal(failureCategory(new Error("Factory version endpoint returned HTTP 503")), "network-failure");
  assert.equal(failureCategory(new Error("Factory version endpoint did not return JSON")), "invalid-metadata");
});

test("patch drift diagnostics include required evidence but only bounded excerpts", () => {
  const { createPatchDriftDiagnostic } = require("../scripts/patch-diagnostics");
  const report = {
    schemaVersion: 1,
    originalHash: "b".repeat(64),
    outcomes: [{
      id: "daemon-transport-force-websocket",
      matchStrategy: "statsig-or-hardcoded-resolver",
      matched: false,
      validationPassed: false,
      evidence: { matcher: "statsigResolverMatcher", matchCount: 0 },
      errors: ["required resolver missing"],
    }],
  };
  const diagnostic = createPatchDriftDiagnostic({
    factoryVersion: "0.140.0",
    rawAsarSha256: "b".repeat(64),
    report,
    excerpts: [{ patchId: "daemon-transport-force-websocket", text: "x".repeat(4000) }],
  });
  assert.deepEqual(diagnostic.failedPatchIds, ["daemon-transport-force-websocket"]);
  assert.equal(diagnostic.failures[0].matcherClass, "statsigResolverMatcher");
  assert.ok(diagnostic.excerpts[0].text.length <= 1024);
  assert.doesNotMatch(JSON.stringify(diagnostic), /app\.asar/);
});

test("patch drift issue summary includes version, hash, failed IDs, and workflow link", () => {
  const { cacheSaveMetadata, summarize } = require("../scripts/watch-summary");
  const hash = "b".repeat(64);
  const report = summarize({
    status: "failure",
    category: "patch-drift",
    message: "Required patch failed",
    diagnostic: {
      factoryVersion: "0.140.0",
      rawAsarSha256: hash,
      failedPatchIds: ["linux-native-updater-button"],
    },
  }, "https://github.example/actions/runs/123");
  assert.match(report.body, /0\.140\.0/);
  assert.match(report.body, new RegExp(hash));
  assert.match(report.body, /linux-native-updater-button/);
  assert.match(report.body, /actions\/runs\/123/);
  assert.deepEqual(cacheSaveMetadata({
    status: "failure",
    factoryVersion: "0.140.0",
    dmgSha256: "a".repeat(64),
    dmgCacheSource: "official",
  }), {
    save: true,
    suffix: `0.140.0-${"a".repeat(64)}`,
  });
  assert.deepEqual(cacheSaveMetadata({
    status: "new-version",
    probe: {
      factoryVersion: "0.140.0",
      dmgSha256: "a".repeat(64),
      dmgCacheSource: "official-cache",
    },
  }), { save: false, suffix: null });
});

test("release rejection summary links bounded patch drift diagnostics", () => {
  const { summarizeReleaseFailure } = require("../scripts/release-failure-summary");
  const summary = summarizeReleaseFailure("0.140.0", {
    rawAsarSha256: "b".repeat(64),
    failedPatchIds: ["linux-native-updater-button"],
  }, "https://github.example/actions/runs/456");
  assert.match(summary, /0\.140\.0/);
  assert.match(summary, new RegExp("b".repeat(64)));
  assert.match(summary, /linux-native-updater-button/);
  assert.match(summary, /actions\/runs\/456/);
  assert.match(summary, /stopped fail-closed/);
});

test("workflow permissions and publication ordering are fail-closed", () => {
  const watch = fs.readFileSync(path.join(ROOT, ".github/workflows/upstream-watch.yml"), "utf8");
  const release = fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");
  assert.match(watch, /schedule:/);
  assert.match(watch, /workflow_dispatch:/);
  assert.match(watch, /contents:\s*read/);
  assert.match(watch, /issues:\s*write/);
  assert.doesNotMatch(watch, /contents:\s*write/);
  assert.match(release, /workflow_dispatch:/);
  assert.match(release, /version:/);
  assert.match(release, /source_ref:/);
  assert.match(release, /publish:[\s\S]*needs:\s*\[build-and-accept\]/);
  assert.match(release, /publish:[\s\S]*contents:\s*write/);
  assert.match(release, /build-and-accept:[\s\S]*contents:\s*read/);
  assert.match(release, /source_commit:[\s\S]*git rev-parse HEAD/);
  assert.match(release, /--target "\$FACTORY_SOURCE_COMMIT"/);
  assert.match(release, /publish:[\s\S]*ref:\s*\$\{\{ github\.sha \}\}/);
  assert.match(release, /publish:[\s\S]*persist-credentials:\s*false/);
  assert.doesNotMatch(release, /publish:[\s\S]*ref:\s*\$\{\{ needs\['build-and-accept'\]\.outputs\.source_commit \}\}/);
  assert.match(release, /verifyReleaseBundle/);
  assert.match(release, /Summarize release rejection/);
  assert.doesNotMatch(release, /--version "\$\{\{ inputs\.version \}\}"/);
  assert.doesNotMatch(release, /VERSION=\$\{\{ inputs\.version \}\}/);
  assert.doesNotMatch(release, /printf[^\n]*inputs\.version/);
  assert.doesNotMatch(release, /gh release create[^\n]*inputs\.version/);
  assert.doesNotMatch(release, /release-assets\/.*\.(?:dmg|asar)/i);
  assert.doesNotMatch(release, /pull_request_target/);
  assert.match(watch, /actions\/cache\/restore@v4/);
  assert.match(watch, /actions\/cache\/save@v4/);
  assert.match(watch, /Save newly downloaded content-addressed DMG[\s\S]*if:\s*always\(\) &&/);
});

test("final regression matrix documents real fixture skips instead of fake passes", () => {
  const runbook = fs.readFileSync(path.join(ROOT, "docs/maintainer-runbook.md"), "utf8");
  for (const required of [
    "synthetic Statsig transport", "synthetic hardcoded IPC transport",
    "raw Factory 0.139.0", "deb/rpm/AppImage", "product-named ELF",
    "protocol MIME", "StartupWMClass", "keyring", "update bridge",
    "daemon adoption", "after-exit", "approval security", "rollback verification",
  ]) assert.match(runbook, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.match(runbook, /0\.137\.0.*SKIP/i);
  assert.match(runbook, /0\.138\.0.*SKIP/i);
});

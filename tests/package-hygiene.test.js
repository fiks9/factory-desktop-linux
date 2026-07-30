"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const asar = require(require.resolve("@electron/asar", { paths: [path.resolve(__dirname, "..", "patcher")] }));
const { scanPackageTree, stageUpdateBuilder, stageInstalledUpdateBuilder } = require("../scripts/package-hygiene");
const { buildAppImage } = require("../scripts/package-appimage");
const { buildDeb } = require("../scripts/package-deb");
const { buildRpm } = require("../scripts/package-rpm");
const { repositoryCommit } = require("../scripts/release-metadata");
const { sha256 } = require("../scripts/runtime");
const {
  assertAllowedNativePayload,
  assertExactDebMaintainerScripts,
  assertNativePackageMetadata,
  assertNativeBuilderProvenance,
  assertNativeUpdaterBridge,
  assertRpmScriptlets,
  inspectExtracted,
} = require("../scripts/inspect-package");

const ACCEPTED_PATCH_IDS = [
  "daemon-transport-force-websocket",
  "prevent-listen-ipc",
  "system-daemon-adoption",
  "system-droid-cli-resolver",
  "linux-native-updater-button",
  "auto-updater-guard",
  "packaged-daemon-mode",
  "disable-keyring",
  "protocol-handler",
  "bundle-javascript-syntax",
];

async function writeSyntaxInvalidStagedApp(appDir) {
  const source = path.join(path.dirname(appDir), "asar-source");
  fs.mkdirSync(path.join(source, ".vite", "build"), { recursive: true });
  fs.writeFileSync(
    path.join(source, ".vite", "build", "index.js"),
    '(()=>0),/* factory-linux:linux-native-updater-button */const broken=1',
  );
  fs.mkdirSync(path.join(appDir, "resources"), { recursive: true });
  await asar.createPackage(source, path.join(appDir, "resources", "app.asar"));
  fs.writeFileSync(
    path.join(appDir, "factory-desktop"),
    Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("syntax fixture")]),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(appDir, "factory-desktop-launcher"),
    '#!/usr/bin/env bash\nAPP_ROOT="$(cd "$(dirname "$0")" && pwd)"\nexec "$APP_ROOT/factory-desktop" "$@"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(appDir, "build-info.json"), JSON.stringify({ binaryName: "factory-desktop" }));
  fs.mkdirSync(path.join(appDir, ".factory-linux"), { recursive: true });
  fs.writeFileSync(path.join(appDir, ".factory-linux", "patch-report.json"), JSON.stringify({
    schemaVersion: 1,
    finalHash: sha256(path.join(appDir, "resources", "app.asar")),
    outcomes: ACCEPTED_PATCH_IDS.map((id) => ({ id, matched: true, validationPassed: true })),
  }));
}

test("native updater bridge is fixed, read-only, and absent from AppImage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-update-bridge-"));
  try {
    const bridge = path.join(root, "usr", "lib", "factory-desktop", "update-bridge.cjs");
    const policy = path.join(root, "usr", "share", "polkit-1", "actions", "org.factory.desktop.update-manager.policy");
    fs.mkdirSync(path.dirname(bridge), { recursive: true });
    fs.mkdirSync(path.dirname(policy), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "..", "packaging", "linux", "update-bridge.cjs"), bridge);
    fs.chmodSync(bridge, 0o644);
    fs.copyFileSync(path.resolve(__dirname, "..", "packaging", "linux", "org.factory.desktop.update-manager.policy"), policy);
    assert.doesNotThrow(() => assertNativeUpdaterBridge(root, "deb"));

    const builderCopy = path.join(root, "usr", "lib", "factory-desktop", "update-builder", "packaging", "linux", "update-bridge.cjs");
    fs.mkdirSync(path.dirname(builderCopy), { recursive: true });
    fs.copyFileSync(bridge, builderCopy);
    assert.doesNotThrow(() => assertNativeUpdaterBridge(root, "rpm"));
    const unexpectedCopy = path.join(root, "usr", "share", "factory-desktop", "update-bridge.cjs");
    fs.mkdirSync(path.dirname(unexpectedCopy), { recursive: true });
    fs.copyFileSync(bridge, unexpectedCopy);
    assert.throws(() => assertNativeUpdaterBridge(root, "deb"), /fixed package path/);
    fs.rmSync(unexpectedCopy);

    fs.chmodSync(bridge, 0o664);
    assert.throws(() => assertNativeUpdaterBridge(root, "rpm"), /0644/);
    fs.chmodSync(bridge, 0o644);
    assert.throws(() => assertNativeUpdaterBridge(root, "appimage"), /must not contain/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("native update-builder provenance is fixed, read-only, and commit-bound", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-builder-provenance-"));
  const commit = "1".repeat(40);
  try {
    const provenance = path.join(root, "usr", "lib", "factory-desktop", "update-builder", "build-provenance.json");
    fs.mkdirSync(path.dirname(provenance), { recursive: true });
    fs.writeFileSync(provenance, `${JSON.stringify({ schemaVersion: 1, repositoryCommit: commit })}\n`, { mode: 0o644 });

    assert.doesNotThrow(() => assertNativeBuilderProvenance(root, "deb", commit));
    assert.throws(() => assertNativeBuilderProvenance(root, "rpm", "2".repeat(40)), /commit mismatch/);
    fs.chmodSync(provenance, 0o664);
    assert.throws(() => assertNativeBuilderProvenance(root, "deb", commit), /non-writable regular file/);
    fs.rmSync(provenance);
    fs.symlinkSync("missing.json", provenance);
    assert.throws(() => assertNativeBuilderProvenance(root, "rpm", commit), /non-writable regular file/);
    fs.rmSync(provenance);
    assert.doesNotThrow(() => assertNativeBuilderProvenance(root, "appimage", commit));
    fs.writeFileSync(provenance, `${JSON.stringify({ schemaVersion: 1, repositoryCommit: commit })}\n`, { mode: 0o644 });
    assert.throws(() => assertNativeBuilderProvenance(root, "appimage", commit), /must not contain/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("package builders reject a syntax-invalid staged ASAR before packaging", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-invalid-staged-asar-"));
  try {
    const appDir = path.join(root, "app");
    await writeSyntaxInvalidStagedApp(appDir);
    const options = { appDir, version: "0.139.0", outputDir: path.join(root, "dist") };

    assert.throws(() => buildDeb(options), /JavaScript syntax/);
    assert.throws(() => buildRpm(options), /JavaScript syntax/);
    await assert.rejects(() => buildAppImage(options), /JavaScript syntax/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extracted deb rpm and AppImage payloads reject syntax-invalid ASARs", async () => {
  for (const format of ["deb", "rpm", "appimage"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `factory-invalid-${format}-`));
    try {
      const appDir = format === "appimage"
        ? path.join(root, "usr", "lib", "factory-desktop")
        : path.join(root, "opt", "Factory");
      await writeSyntaxInvalidStagedApp(appDir);
      assert.throws(() => inspectExtracted(root, format), /JavaScript syntax/, format);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("hygiene gate rejects absolute CI .bin symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-broken-link-"));
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  fs.symlinkSync("/home/runner/work/factory/node_modules/electron-builder/cli.js", path.join(root, "node_modules", ".bin", "electron-builder"));
  assert.throws(() => scanPackageTree(root), /must be relative|forbidden build path/);
});

test("hygiene gate rejects a non-executable 7za fixture", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-broken-7za-"));
  const binary = path.join(root, "node_modules", "7zip-bin", "linux", "x64", "7za");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "binary fixture", { mode: 0o644 });
  assert.throws(() => scanPackageTree(root), /7zip binary is not executable/);
});

test("hygiene gate accepts valid relative executable .bin links", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-clean-bin-"));
  const target = path.join(root, "node_modules", "tool", "cli.js");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.symlinkSync("../tool/cli.js", path.join(root, "node_modules", ".bin", "tool"));
  assert.equal(scanPackageTree(root).valid, true);
});

test("hygiene gate permits only the canonical installed copy of its own rule text", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-nested-scanner-"));
  try {
    const scanner = path.join(root, "usr", "lib", "factory-desktop", "update-builder", "scripts", "package-hygiene.js");
    fs.mkdirSync(path.dirname(scanner), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "..", "scripts", "package-hygiene.js"), scanner);
    assert.doesNotThrow(() => scanPackageTree(root));
    const disguised = path.join(root, "opt", "Factory", "package-hygiene.js");
    fs.mkdirSync(path.dirname(disguised), { recursive: true });
    fs.copyFileSync(scanner, disguised);
    assert.throws(() => scanPackageTree(root), /forbidden build path/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("update-builder is installed cleanly instead of copying workspace node_modules", () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "factory-update-builder-"));
  try {
    const result = stageUpdateBuilder(path.resolve(__dirname, "..", "patcher"), path.join(destination, "builder"));
    assert.equal(result.valid, true);
    assert.equal(fs.existsSync(path.join(destination, "builder", "node_modules", "@electron", "asar")), true);
  } finally { fs.rmSync(destination, { recursive: true, force: true }); }
});

test("installed update-builder carries scripts and a clean patcher dependency tree", () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "factory-installed-builder-"));
  try {
    const builder = path.join(destination, "update-builder");
    const result = stageInstalledUpdateBuilder(path.resolve(__dirname, ".."), builder);
    assert.equal(result.valid, true);
    assert.equal(fs.existsSync(path.join(builder, "scripts", "build-app.js")), true);
    assert.equal(fs.existsSync(path.join(builder, "scripts", "inspect-package.js")), true);
    assert.equal(fs.existsSync(path.join(builder, "patcher", "node_modules", "@electron", "asar")), true);
    const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(__dirname, ".."), encoding: "utf8",
    }).trim();
    assert.equal(repositoryCommit(builder), expectedCommit);
  } finally { fs.rmSync(destination, { recursive: true, force: true }); }
});

test("native package metadata is bound to Factory Desktop build identity", () => {
  assert.doesNotThrow(() => assertNativePackageMetadata("deb", {
    name: "factory-desktop", version: "0.139.0", architecture: "amd64",
  }, "0.139.0"));
  assert.throws(() => assertNativePackageMetadata("deb", {
    name: "factory-desktop-rootkit", version: "0.139.0", architecture: "amd64",
  }, "0.139.0"), /package name/);
  assert.throws(() => assertNativePackageMetadata("rpm", {
    name: "factory-desktop", version: "0.140.0", architecture: "x86_64",
  }, "0.139.0"), /package version/);

  assert.doesNotThrow(() => assertNativePackageMetadata("deb", {
    name: "factory-desktop", version: "0.139.0-1", architecture: "amd64",
  }, {
    factoryVersion: "0.139.0", packageVersion: "0.139.0-1", packageRelease: "1",
  }));
  assert.doesNotThrow(() => assertNativePackageMetadata("rpm", {
    name: "factory-desktop", version: "0.139.0", release: "2", architecture: "x86_64",
  }, {
    factoryVersion: "0.139.0", packageVersion: "0.139.0", packageRelease: "2",
  }));
});

test("native payload rejects files outside canonical installation roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-native-payload-"));
  try {
    fs.mkdirSync(path.join(root, "opt", "Factory"), { recursive: true });
    fs.writeFileSync(path.join(root, "opt", "Factory", "factory-desktop"), "fixture");
    assert.doesNotThrow(() => assertAllowedNativePayload(root, "deb"));
    fs.mkdirSync(path.join(root, "etc", "sudoers.d"), { recursive: true });
    fs.writeFileSync(path.join(root, "etc", "sudoers.d", "factory"), "ALL ALL=(ALL) NOPASSWD:ALL");
    assert.throws(() => assertAllowedNativePayload(root, "deb"), /unexpected package payload path/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("deb maintainer scripts must exactly match repository-owned scripts", () => {
  const control = fs.mkdtempSync(path.join(os.tmpdir(), "factory-deb-control-"));
  try {
    fs.writeFileSync(path.join(control, "control"), "Package: factory-desktop\n");
    for (const name of ["postinst", "prerm", "postrm"]) {
      fs.copyFileSync(path.resolve(__dirname, "..", "packaging", "linux", `factory-desktop.${name}`), path.join(control, name));
    }
    assert.doesNotThrow(() => assertExactDebMaintainerScripts(control));
    fs.writeFileSync(path.join(control, "preinst"), "#!/bin/sh\ntouch /root/owned\n");
    assert.throws(() => assertExactDebMaintainerScripts(control), /unexpected deb control member/);
  } finally { fs.rmSync(control, { recursive: true, force: true }); }
});

test("rpm scriptlets reject any command outside the canonical post-install body", () => {
  const { RPM_PRE_UNINSTALL } = require("../scripts/package-contract");
  const valid = {
    postinProgram: "/bin/sh",
    postin: require("../scripts/package-rpm").RPM_POST_INSTALL,
    preinProgram: "(none)", prein: "(none)",
    preunProgram: "/bin/sh", preun: RPM_PRE_UNINSTALL,
    postunProgram: "(none)", postun: "(none)",
  };
  assert.doesNotThrow(() => assertRpmScriptlets(valid));
  assert.throws(() => assertRpmScriptlets({ ...valid, preinProgram: "/bin/sh", prein: "touch /root/owned" }), /unexpected RPM scriptlet/);
});

test("rpm versions cannot silently drop prerelease identity", () => {
  const { rpmVersion } = require("../scripts/package-rpm");
  assert.equal(rpmVersion("0.139.0"), "0.139.0");
  assert.throws(() => rpmVersion("0.140.0-beta.1"), /prerelease/);
});

test("native package lifecycle enables and reloads both user services", () => {
  const postinst = fs.readFileSync(path.resolve(__dirname, "..", "packaging", "linux", "factory-desktop.postinst"), "utf8");
  const prerm = fs.readFileSync(path.resolve(__dirname, "..", "packaging", "linux", "factory-desktop.prerm"), "utf8");
  const service = fs.readFileSync(path.resolve(__dirname, "..", "packaging", "linux", "factory-update-manager.service"), "utf8");
  const { RPM_POST_INSTALL, RPM_PRE_UNINSTALL } = require("../scripts/package-contract");
  for (const name of ["factory-update-manager.service", "factory-droid-daemon.service"]) {
    for (const text of [postinst, prerm, RPM_POST_INSTALL, RPM_PRE_UNINSTALL]) {
      assert.match(text, new RegExp(name.replaceAll(".", "\\.")));
    }
  }
  assert.match(postinst, /systemctl --global enable/);
  assert.match(prerm, /systemctl --global disable/);
  assert.match(RPM_POST_INSTALL, /systemctl --global enable/);
  assert.match(RPM_PRE_UNINSTALL, /systemctl --global disable/);
  for (const text of [postinst, RPM_POST_INSTALL]) assert.match(text, /systemctl --user enable --now/);
  for (const text of [prerm, RPM_PRE_UNINSTALL]) assert.match(text, /systemctl --user disable --now/);
  for (const text of [postinst, prerm, RPM_POST_INSTALL, RPM_PRE_UNINSTALL]) {
    assert.match(text, /systemctl --user daemon-reload/);
    assert.doesNotMatch(text, /systemctl --global daemon-reload/);
  }
  assert.match(service, /Type=simple/);
  assert.match(service, /ExecStart=\/usr\/bin\/factory-update-manager daemon/);
  assert.match(service, /Restart=on-failure/);
  const restartSec = Number(service.match(/RestartSec=(\d+)/)?.[1]);
  assert.ok(restartSec >= 30);
});

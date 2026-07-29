"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { scanPackageTree, stageUpdateBuilder } = require("../scripts/package-hygiene");

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

test("update-builder is installed cleanly instead of copying workspace node_modules", () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "factory-update-builder-"));
  try {
    const result = stageUpdateBuilder(path.resolve(__dirname, "..", "patcher"), path.join(destination, "builder"));
    assert.equal(result.valid, true);
    assert.equal(fs.existsSync(path.join(destination, "builder", "node_modules", "@electron", "asar")), true);
  } finally { fs.rmSync(destination, { recursive: true, force: true }); }
});

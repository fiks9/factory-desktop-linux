"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { repositoryCommit, writeBuilderProvenance } = require("./release-metadata");

function isExecutable(stat) { return (stat.mode & 0o111) !== 0; }
function isElf(file) {
  try { return fs.readFileSync(file).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])); } catch { return false; }
}

function fileContains(file, needle) {
  if (!needle) return false;
  const target = Buffer.from(needle), buffer = Buffer.alloc(1024 * 1024 + target.length), fd = fs.openSync(file, "r");
  let carry = 0;
  try {
    while (true) {
      const read = fs.readSync(fd, buffer, carry, 1024 * 1024, null);
      if (read === 0) return false;
      const length = carry + read;
      if (buffer.subarray(0, length).includes(target)) return true;
      carry = Math.min(target.length - 1, length);
      buffer.copy(buffer, 0, length - carry, length);
    }
  } finally { fs.closeSync(fd); }
}

function scanPackageTree(root, options = {}) {
  root = path.resolve(root);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Hygiene root is not a directory: ${root}`);
  const errors = [];
  const forbiddenLinks = ["/home/runner/work", "/tmp/", ...(options.forbiddenPaths || []), options.workspaceRoot].filter(Boolean);
  const forbiddenContents = ["/home/runner/work", options.workspaceRoot].filter(Boolean);
  let files = 0, symlinks = 0, executables = 0;
  const checkExecutable = (file, reason) => {
    const stat = fs.statSync(file);
    if (!isExecutable(stat)) errors.push(`${reason} is not executable: ${path.relative(root, file)}`);
    else executables++;
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), rel = path.relative(root, full);
      if (entry.isSymbolicLink()) {
        symlinks++;
        const target = fs.readlinkSync(full);
        if (forbiddenLinks.some((value) => target.includes(value))) errors.push(`Symlink contains forbidden build path: ${rel} -> ${target}`);
        if (rel.includes(`${path.sep}node_modules${path.sep}.bin${path.sep}`) || rel.startsWith(`node_modules${path.sep}.bin${path.sep}`)) {
          if (path.isAbsolute(target)) errors.push(`node_modules/.bin symlink must be relative: ${rel} -> ${target}`);
          const resolved = path.resolve(path.dirname(full), target);
          if (!fs.existsSync(resolved)) errors.push(`node_modules/.bin symlink is broken: ${rel} -> ${target}`);
          else checkExecutable(resolved, "node_modules/.bin target");
        }
        continue;
      }
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      files++;
      if (rel.includes(`${path.sep}node_modules${path.sep}.bin${path.sep}`) || rel.startsWith(`node_modules${path.sep}.bin${path.sep}`)) checkExecutable(full, "node_modules/.bin file");
      if (/7zip-bin[\\/].*[\\/](?:7za|7zz)$/.test(rel)) checkExecutable(full, "7zip binary");
      if (isElf(full) && !/\.(?:so(?:\.\d+)*)$/.test(entry.name)) checkExecutable(full, "native ELF binary");
      // Only repository and installed-builder copies of the scanner may name
      // the forbidden CI path as part of this rule.
      const scannerPaths = [
        path.join("scripts", "package-hygiene.js"),
        path.join("usr", "lib", "factory-desktop", "update-builder", "scripts", "package-hygiene.js"),
      ];
      if (!scannerPaths.includes(rel)) {
        for (const value of forbiddenContents) if (fileContains(full, value)) errors.push(`File contains forbidden build path: ${rel}: ${value}`);
      }
    }
  };
  walk(root);
  if (errors.length) throw new Error(`Package hygiene failed (${errors.length}):\n${errors.map((error) => `- ${error}`).join("\n")}`);
  return { root, files, symlinks, executables, valid: true };
}

function stageUpdateBuilder(sourceRoot, destination) {
  sourceRoot = path.resolve(sourceRoot); destination = path.resolve(destination);
  for (const required of ["package.json", "package-lock.json", "src"]) if (!fs.existsSync(path.join(sourceRoot, required))) throw new Error(`Update-builder source is missing ${required}`);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const entry of ["package.json", "package-lock.json", "src", "dist"]) {
    const source = path.join(sourceRoot, entry);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(destination, entry), { recursive: true, dereference: false });
  }
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: destination, stdio: "pipe", timeout: 10 * 60 * 1000 });
  return scanPackageTree(destination, { workspaceRoot: sourceRoot });
}

function stageInstalledUpdateBuilder(sourceRoot, destination) {
  sourceRoot = path.resolve(sourceRoot); destination = path.resolve(destination);
  for (const entry of ["assets", "launcher", "packaging", "scripts", "patcher"]) if (!fs.existsSync(path.join(sourceRoot, entry))) throw new Error(`Installed update-builder source is missing ${entry}`);
  const commit = repositoryCommit(sourceRoot);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const entry of ["assets", "launcher", "packaging", "scripts"]) fs.cpSync(path.join(sourceRoot, entry), path.join(destination, entry), { recursive: true, dereference: false });
  stageUpdateBuilder(path.join(sourceRoot, "patcher"), path.join(destination, "patcher"));
  writeBuilderProvenance(destination, commit);
  return scanPackageTree(destination, { workspaceRoot: sourceRoot });
}

module.exports = { scanPackageTree, stageUpdateBuilder, stageInstalledUpdateBuilder };

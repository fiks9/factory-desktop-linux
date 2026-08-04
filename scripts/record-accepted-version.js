#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseVersion } = require("./dmg");

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === b) return 0;
  const parts = (value) => value.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/).slice(1);
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

function updateAcceptedVersion(file, version, commit) {
  const acceptedVersion = parseVersion(version);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Accepted upstream commit is invalid");
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  if (current.schemaVersion !== 1) throw new Error("Accepted upstream schema is invalid");
  const currentVersion = parseVersion(current.acceptedVersion);
  if (compareVersions(acceptedVersion, currentVersion) < 0) {
    return { changed: false, reason: "refusing-version-regression", acceptedVersion: currentVersion };
  }
  if (acceptedVersion === currentVersion && current.acceptedCommit === commit) {
    return { changed: false, reason: "already-recorded", acceptedVersion };
  }
  const value = { schemaVersion: 1, acceptedVersion, acceptedCommit: commit };
  const temporary = `${file}.${process.pid}.partial`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  return { changed: true, acceptedVersion, acceptedCommit: commit };
}

function main() {
  const [file, version, commit] = process.argv.slice(2);
  if (!file || !version || !commit) throw new Error("Usage: record-accepted-version.js FILE VERSION COMMIT");
  process.stdout.write(`${JSON.stringify(updateAcceptedVersion(path.resolve(file), version, commit))}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = { compareVersions, updateAcceptedVersion };

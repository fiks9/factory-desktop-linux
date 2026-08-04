#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { parseVersion } = require("./dmg");

function parseReleaseTag(tag) {
  if (typeof tag !== "string") return null;
  const wrapper = tag.match(/^v(.+)-linux\.([1-9][0-9]*)$/);
  const rawVersion = wrapper ? wrapper[1] : tag.match(/^v(.+)$/)?.[1];
  if (!rawVersion) return null;
  try {
    return {
      tag,
      version: parseVersion(rawVersion),
      revisionNumber: wrapper ? Number(wrapper[2]) : null,
    };
  } catch {
    return null;
  }
}

function nextWrapperRevision(tags) {
  let highest = 0;
  for (const tag of tags) {
    const parsed = parseReleaseTag(tag);
    if (parsed && parsed.revisionNumber !== null) highest = Math.max(highest, parsed.revisionNumber);
  }
  if (highest >= Number.MAX_SAFE_INTEGER) throw new Error("Wrapper revision number is exhausted");
  return `linux.${highest + 1}`;
}

function planAutomaticRelease({ version, probeStatus, tags }) {
  const factoryVersion = parseVersion(version);
  if (probeStatus !== "accepted") {
    return { action: "blocked", reason: "probe-not-accepted", factoryVersion, wrapperRevision: null };
  }
  const parsedTags = tags.map(parseReleaseTag).filter(Boolean);
  const existing = parsedTags.filter((entry) => entry.version === factoryVersion);
  if (existing.length) {
    return {
      action: "already-published",
      reason: "release-tag-already-exists",
      factoryVersion,
      wrapperRevision: null,
      existingTags: existing.map((entry) => entry.tag).sort(),
    };
  }
  return {
    action: "dispatch",
    reason: "accepted-probe-ready",
    factoryVersion,
    wrapperRevision: nextWrapperRevision(tags),
    sourceRef: "main",
  };
}

function readTags(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const version = value("--version");
  const probeStatus = value("--probe-status");
  const tagsFile = value("--tags-file");
  if (!version || !probeStatus || !tagsFile) throw new Error("Usage: auto-release.js --version VERSION --probe-status STATUS --tags-file FILE");
  const plan = planAutomaticRelease({ version, probeStatus, tags: readTags(tagsFile) });
  if (process.env.GITHUB_OUTPUT) {
    const outputs = {
      action: plan.action,
      factory_version: plan.factoryVersion,
      wrapper_revision: plan.wrapperRevision,
      source_ref: plan.sourceRef,
    };
    for (const [key, value] of Object.entries(outputs)) {
      if (value !== null && value !== undefined) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = { nextWrapperRevision, parseReleaseTag, planAutomaticRelease };

#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function cacheSaveMetadata(result) {
  const source = result.probe?.dmgCacheSource || result.dmgCacheSource;
  const version = result.probe?.factoryVersion || result.factoryVersion || result.latestVersion;
  const digest = result.probe?.dmgSha256 || result.dmgSha256;
  if (source !== "official" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version || "") || !/^[a-f0-9]{64}$/.test(digest || "")) {
    return { save: false, suffix: null };
  }
  return { save: true, suffix: `${version}-${digest}` };
}

function summarize(result, runUrl) {
  const version = result.latestVersion || result.factoryVersion || result.diagnostic?.factoryVersion || "unknown";
  if (result.status === "current") {
    return { issue: false, title: null, body: null, summary: `## Upstream watch\n\nFactory ${version} is already accepted.\n` };
  }
  if (result.status === "new-version") {
    const probe = result.probe;
    return {
      issue: true,
      title: `[upstream-watch] Factory ${version} is available`,
      body: [
        `Factory ${version} is newer than accepted ${result.acceptedVersion}.`,
        probe ? `Patch probe: ${probe.status}; DMG SHA-256: ${probe.dmgSha256}; raw ASAR SHA-256: ${probe.rawAsarSha256}.` : "Patch probe was not requested.",
        `Workflow: ${runUrl}`,
        "No release was published automatically. Run the manual release workflow after review.",
      ].join("\n\n"),
      summary: `## New Factory version\n\n- Version: ${version}\n- Probe: ${probe?.status || "not run"}\n- Workflow: ${runUrl}\n`,
    };
  }
  const category = result.category || result.status;
  const failed = result.diagnostic?.failedPatchIds || [];
  const rawAsarHash = result.diagnostic?.rawAsarSha256 || "unavailable";
  const dmgHash = result.dmgSha256 || "unavailable";
  return {
    issue: true,
    title: `[upstream-watch] ${category} for Factory ${version}`,
    body: [
      `Upstream watch failed closed (${category}).`,
      `Factory version: ${version}.`,
      `DMG SHA-256: ${dmgHash}. Raw ASAR SHA-256: ${rawAsarHash}.`,
      `Reason: ${String(result.message || result.status).slice(0, 512)}`,
      failed.length ? `Failed patches: ${failed.join(", ")}` : "Failed patches: unavailable.",
      `Workflow and diagnostic artifacts: ${runUrl}`,
      "Packaging and release publication did not run.",
    ].join("\n\n"),
    summary: `## Upstream watch failure\n\n- Category: ${category}\n- Version: ${version}\n- DMG SHA-256: ${dmgHash}\n- Raw ASAR SHA-256: ${rawAsarHash}\n- Failed patches: ${failed.join(", ") || "unavailable"}\n- Workflow: ${runUrl}\n`,
  };
}

function main() {
  const [input, outputDir, runUrl] = process.argv.slice(2);
  if (!input || !outputDir || !runUrl) throw new Error("Usage: watch-summary.js result.json output-dir run-url");
  const result = JSON.parse(fs.readFileSync(input, "utf8"));
  const report = summarize(result, runUrl);
  const cache = cacheSaveMetadata(result);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "summary.md"), report.summary);
  if (report.issue) {
    fs.writeFileSync(path.join(outputDir, "issue-title.txt"), `${report.title}\n`);
    fs.writeFileSync(path.join(outputDir, "issue-body.md"), `${report.body}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `issue=${report.issue}\ncache_save=${cache.save}\n`);
    if (cache.suffix) fs.appendFileSync(process.env.GITHUB_OUTPUT, `cache_suffix=${cache.suffix}\n`);
  }
  process.stdout.write(`${JSON.stringify({ issue: report.issue })}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = { cacheSaveMetadata, summarize };

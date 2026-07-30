#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function summarizeReleaseFailure(version, diagnostic, runUrl) {
  const failed = Array.isArray(diagnostic?.failedPatchIds) ? diagnostic.failedPatchIds : [];
  return [
    "## Release rejected",
    "",
    `- Factory version: ${String(version).slice(0, 64)}`,
    `- Raw ASAR SHA-256: ${diagnostic?.rawAsarSha256 || "unavailable"}`,
    `- Failed patches: ${failed.join(", ") || "unavailable"}`,
    `- Diagnostics: ${runUrl}`,
    "- Packaging and publication stopped fail-closed.",
    "",
  ].join("\n");
}

function main() {
  const [version, diagnosticsDir, runUrl] = process.argv.slice(2);
  if (!version || !diagnosticsDir || !runUrl) throw new Error("Usage: release-failure-summary.js version diagnostics-dir run-url");
  let diagnostic = null;
  try {
    diagnostic = JSON.parse(fs.readFileSync(path.join(diagnosticsDir, "patch-drift.json"), "utf8"));
  } catch {}
  process.stdout.write(summarizeReleaseFailure(version, diagnostic, runUrl));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = { summarizeReleaseFailure };

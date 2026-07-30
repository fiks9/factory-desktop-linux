#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_EXCERPT = 1024;

function boundedText(value, limit = MAX_EXCERPT) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .slice(0, limit);
}

function failedOutcomes(report) {
  return (report?.outcomes || []).filter((outcome) =>
    !(outcome.matched || outcome.alreadyPatched) || !outcome.validationPassed);
}

function matchCount(outcome) {
  if (Number.isSafeInteger(outcome.evidence?.matchCount)) return outcome.evidence.matchCount;
  if (Number.isSafeInteger(outcome.evidence?.matches)) return outcome.evidence.matches;
  if (outcome.evidence?.handlerCounts && typeof outcome.evidence.handlerCounts === "object") {
    return Object.values(outcome.evidence.handlerCounts).reduce((total, count) => total + Number(count || 0), 0);
  }
  return outcome.matched ? 1 : 0;
}

function createPatchDriftDiagnostic(options) {
  const failures = failedOutcomes(options.report);
  const failedPatchIds = failures.map((outcome) => outcome.id);
  const fingerprintInput = JSON.stringify({
    rawAsarSha256: options.rawAsarSha256,
    failedPatchIds,
    evidence: failures.map((outcome) => outcome.evidence || {}),
  });
  return {
    schemaVersion: 1,
    factoryVersion: options.factoryVersion,
    rawAsarSha256: options.rawAsarSha256,
    bundleFingerprint: crypto.createHash("sha256").update(fingerprintInput).digest("hex"),
    failedPatchIds,
    failures: failures.map((outcome) => ({
      patchId: outcome.id,
      matcherClass: outcome.evidence?.matcher || outcome.matchStrategy || "unknown",
      matchCount: matchCount(outcome),
      evidence: outcome.evidence || {},
      validatorFailure: (outcome.errors || []).map((error) => boundedText(error, 512)),
    })),
    excerpts: (options.excerpts || []).map((entry) => ({
      patchId: entry.patchId,
      file: entry.file ? boundedText(entry.file, 256) : undefined,
      anchor: entry.anchor ? boundedText(entry.anchor, 128) : undefined,
      text: boundedText(entry.text),
    })),
  };
}

function writePatchDriftArtifacts(directory, options) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const reportPath = path.join(directory, "patch-report.json");
  const diagnosticPath = path.join(directory, "patch-drift.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(options.report, null, 2)}\n`, { mode: 0o600 });
  const diagnostic = createPatchDriftDiagnostic(options);
  fs.writeFileSync(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600 });
  return { diagnostic, diagnosticPath, reportPath };
}

module.exports = { MAX_EXCERPT, boundedText, createPatchDriftDiagnostic, failedOutcomes, matchCount, writePatchDriftArtifacts };

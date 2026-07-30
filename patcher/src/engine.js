"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sha256File, listJavaScriptFiles, readFile, replaceFilesAtomic } = require("./asar-io");
const { assertDescriptor, CRITICAL_POLICY } = require("./contract");
const { validateJavaScriptFiles } = require("./javascript-syntax");
const patches = require("./patches");
const validators = require("./validators");

const DESCRIPTORS = [
  { id: "daemon-transport-force-websocket", description: "Force WebSocket transport on Linux", phase: "main-bundle", ciPolicy: CRITICAL_POLICY, matchStrategy: "statsigResolverMatcher -> hardcodedIpcResolverMatcher -> callsiteBacktraceMatcher", migrationMarkers: ["factory-linux:daemon-transport-force-websocket"], apply: patches.daemonTransport, validate: validators.validateTransport },
  { id: "prevent-listen-ipc", description: "Prevent --listen ipc on Linux", phase: "main-bundle", ciPolicy: CRITICAL_POLICY, matchStrategy: "daemon spawn args structural matcher", migrationMarkers: ["factory-linux:prevent-listen-ipc"], apply: patches.preventListen, validate: validators.validateListenIpc },
  { id: "system-daemon-adoption", description: "Adopt the user-owned system Droid daemon", phase: "main-bundle", ciPolicy: CRITICAL_POLICY, matchStrategy: "daemon start path anchor", migrationMarkers: ["factory-linux:system-daemon-adoption"], apply: patches.adoption, validate: validators.validateAdoption },
  { id: "system-droid-cli-resolver", description: "Resolve the current system droid executable", phase: "main-bundle", ciPolicy: CRITICAL_POLICY, matchStrategy: "packaged process.resourcesPath resolver", migrationMarkers: ["factory-linux:system-droid-cli-resolver"], apply: patches.systemDroid, validate: validators.validateSystemDroid },
  { id: "linux-window-controls", description: "Provide Electron window controls and a packaged icon on Linux", phase: "main-bundle", ciPolicy: CRITICAL_POLICY, matchStrategy: "BrowserWindow titleBarStyle plus trafficLightPosition structural matcher", migrationMarkers: ["factory-linux:linux-window-controls"], apply: patches.windowControls, validate: validators.validateWindowControls },
  { id: "linux-native-updater-button", description: "Bridge Linux update actions to factory-update-manager", phase: "main-bundle", ciPolicy: CRITICAL_POLICY, matchStrategy: "autoUpdater update action callsite", migrationMarkers: ["factory-linux:linux-native-updater-button"], apply: patches.nativeUpdater, validate: validators.validateNativeUpdater },
  { id: "auto-updater-guard", description: "Guard Electron autoUpdater on Linux", phase: "main-bundle", ciPolicy: CRITICAL_POLICY, matchStrategy: "autoUpdater callsite guard", migrationMarkers: ["factory-linux:auto-updater-guard"], apply: patches.autoUpdater, validate: validators.validateAutoUpdater },
];

function writeReport(reportPath, report) {
  if (!reportPath) return;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function packagingOutcomes(projectRoot) {
  const results = validators.validatePackaging(projectRoot);
  return [
    { id: "disable-keyring", description: "Force file-backed auth storage on Linux", phase: "packaging", ciPolicy: CRITICAL_POLICY, matchStrategy: "launcher/desktop/AppRun validator", matched: true, patched: false, alreadyPatched: true, validationPassed: results.keyring.validationPassed, errors: results.keyring.errors, evidence: results.keyring.evidence },
    { id: "protocol-handler", description: "Register factory-desktop OAuth protocol", phase: "packaging", ciPolicy: CRITICAL_POLICY, matchStrategy: "desktop metadata validator", matched: true, patched: false, alreadyPatched: true, validationPassed: results.protocol.validationPassed, errors: results.protocol.errors, evidence: results.protocol.evidence },
  ];
}

function runtimeOutcomes(files) {
  const result = validators.validatePackagedDaemonMode(files);
  return [{ id: "packaged-daemon-mode", description: "Prove packaged daemon paths exclude development arguments", phase: "post-patch-validation", ciPolicy: CRITICAL_POLICY, matchStrategy: "app.isPackaged daemon branch validator", matched: true, patched: false, alreadyPatched: true, validationPassed: result.validationPassed, errors: result.errors, evidence: result.evidence }];
}

function syntaxOutcome(files, originalContents) {
  const changedPaths = new Set(files
    .filter((file) => file.content !== originalContents.get(file.path))
    .map((file) => file.path));
  const validation = validateJavaScriptFiles(files, { changedPaths });
  return {
    id: "bundle-javascript-syntax",
    description: "Parse changed and Factory-marker-bearing JavaScript bundles",
    phase: "post-patch-validation",
    ciPolicy: CRITICAL_POLICY,
    matchStrategy: "node:vm complete CommonJS script parse",
    matched: validation.evidence.checkedFiles > 0,
    patched: false,
    alreadyPatched: true,
    validationPassed: validation.validationPassed,
    errors: validation.errors,
    evidence: validation.evidence,
  };
}

function makeFiles(asarPath) {
  return listJavaScriptFiles(asarPath).map((rawPath) => {
    const filePath = rawPath.replace(/^\/+/, "");
    return { path: filePath, content: readFile(asarPath, filePath) };
  });
}

function applyChanges(files, changes) {
  for (const [filePath, content] of changes) {
    const file = files.find((candidate) => candidate.path === filePath);
    if (!file) throw new Error(`Patch returned unknown ASAR file: ${filePath}`);
    file.content = content;
  }
}

function validateFiles(files, validator) {
  return validator(files);
}

const DIAGNOSTIC_ANCHORS = {
  "daemon-transport-force-websocket": ["DesktopDaemonIpc", "resolveTransportMode"],
  "prevent-listen-ipc": ["--listen", "ipc"],
  "system-daemon-adoption": ["--enable-child-ipc", "startInternal"],
  "system-droid-cli-resolver": ["process.resourcesPath", "droid"],
  "linux-window-controls": ["titleBarStyle", "trafficLightPosition", "titleBarOverlay"],
  "linux-native-updater-button": ["updates:getState", "updates:install", "updates:checkNow"],
  "auto-updater-guard": ["autoUpdater.checkForUpdates", "autoUpdater.quitAndInstall"],
  "packaged-daemon-mode": ["app.isPackaged", "--debug"],
};

function diagnosticExcerpts(files, patchId) {
  const anchors = DIAGNOSTIC_ANCHORS[patchId] || [];
  const excerpts = [];
  for (const file of files) {
    for (const anchor of anchors) {
      const index = file.content.indexOf(anchor);
      if (index < 0) continue;
      const start = Math.max(0, index - 384);
      excerpts.push({
        patchId,
        file: file.path,
        anchor,
        text: file.content.slice(start, start + 1024),
      });
      if (excerpts.length >= 3) return excerpts;
    }
  }
  if (patchId === "bundle-javascript-syntax") {
    for (const file of files) {
      const index = file.content.indexOf("factory-linux:");
      if (index < 0) continue;
      const start = Math.max(0, index - 384);
      excerpts.push({
        patchId,
        file: file.path,
        anchor: "factory-linux:",
        text: file.content.slice(start, start + 1024),
      });
      if (excerpts.length >= 3) break;
    }
  }
  return excerpts;
}

async function patchAsar(options) {
  const asarPath = path.resolve(options.asarPath);
  if (!fs.existsSync(asarPath)) throw new Error(`ASAR not found: ${asarPath}`);
  const originalHash = sha256File(asarPath);
  const files = makeFiles(asarPath);
  const originalContents = new Map(files.map((file) => [file.path, file.content]));
  if (files.length === 0) throw new Error("ASAR has no JavaScript files; refusing to patch");
  const outcomes = [];
  let workingFiles = files;

  for (const descriptor of DESCRIPTORS.map(assertDescriptor)) {
    const outcome = descriptor.apply(workingFiles);
    applyChanges(workingFiles, outcome.changes);
    const validation = validateFiles(workingFiles, descriptor.validate);
    const complete = {
      id: descriptor.id,
      description: descriptor.description,
      phase: descriptor.phase,
      ciPolicy: descriptor.ciPolicy,
      matchStrategy: descriptor.matchStrategy,
      migrationMarkers: descriptor.migrationMarkers,
      matched: outcome.matched,
      patched: outcome.patched,
      alreadyPatched: outcome.alreadyPatched,
      validationPassed: validation.validationPassed,
      errors: [...(outcome.errors || []), ...(validation.errors || [])],
      evidence: { ...(outcome.evidence || {}), ...(validation.evidence || {}) },
    };
    outcomes.push(complete);
    if (descriptor.ciPolicy === CRITICAL_POLICY && (!(complete.matched || complete.alreadyPatched) || !complete.validationPassed)) {
      const error = new Error(`Required patch failed: ${descriptor.id}`);
      error.report = { schemaVersion: 1, asarPath: path.basename(asarPath), originalHash, finalHash: originalHash, changed: false, outcomes };
      error.excerpts = diagnosticExcerpts(workingFiles, descriptor.id);
      writeReport(options.reportPath, error.report);
      throw error;
    }
  }

  for (const outcome of [...runtimeOutcomes(workingFiles), ...packagingOutcomes(options.projectRoot || path.resolve(__dirname, "..", ".."))]) {
    outcomes.push(outcome);
    if (!outcome.validationPassed) {
      const error = new Error(`Required patch failed: ${outcome.id}`);
      error.report = { schemaVersion: 1, asarPath: path.basename(asarPath), originalHash, finalHash: originalHash, changed: false, outcomes };
      error.excerpts = diagnosticExcerpts(workingFiles, outcome.id);
      writeReport(options.reportPath, error.report);
      throw error;
    }
  }

  const syntax = syntaxOutcome(workingFiles, originalContents);
  outcomes.push(syntax);
  if (!syntax.validationPassed) {
    const error = new Error(`Required patch failed: ${syntax.id}`);
    error.report = { schemaVersion: 1, asarPath: path.basename(asarPath), originalHash, finalHash: originalHash, changed: false, outcomes };
    error.excerpts = diagnosticExcerpts(workingFiles, syntax.id);
    writeReport(options.reportPath, error.report);
    throw error;
  }

  const changed = outcomes.some((outcome) => outcome.patched);
  if (changed) {
    const finalChanges = workingFiles
      .filter((file) => file.content !== originalContents.get(file.path))
      .map((file) => [file.path, file.content]);
    await replaceFilesAtomic(asarPath, finalChanges);
  }
  const finalHash = sha256File(asarPath);
  const report = { schemaVersion: 1, asarPath: path.basename(asarPath), originalHash, finalHash, changed, outcomes };
  writeReport(options.reportPath, report);
  return report;
}

module.exports = { DESCRIPTORS, patchAsar, makeFiles };

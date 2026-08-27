"use strict";

const fs = require("node:fs");
const childProcess = require("node:child_process");

const HELPER = "/usr/bin/factory-update-manager";
const HELPER_TIMEOUT_MS = 5000;
const MAX_TEXT_LENGTH = 512;
const STARTUP_SYNC_DELAYS_MS = Object.freeze([250, 1000, 3000, 7000, 15000]);
const ACTIVE_POLL_INTERVAL_MS = 30000;
const ACTIVE_UPDATE_STATES = new Set(["checking", "downloading", "building", "validating"]);
const STARTUP_TERMINAL_STATES = new Set([
  "ready-pending-exit",
  "installing",
  "installed",
  "install-failed-manual-action",
  "rolled-back",
  "failed",
  "update-manager-unavailable",
]);
const LINUX_STATES = new Set([
  "idle",
  "checking",
  "downloading",
  "building",
  "validating",
  "ready-pending-exit",
  "installing",
  "installed",
  "install-failed-manual-action",
  "rolled-back",
  "failed",
]);
const COMPATIBILITY_KINDS = Object.freeze({
  idle: "idle",
  checking: "checking",
  downloading: "downloading",
  building: "downloading",
  validating: "downloading",
  "ready-pending-exit": "available",
  installing: "downloading",
  installed: "idle",
  "install-failed-manual-action": "error",
  "rolled-back": "idle",
  failed: "error",
});

function strictFactoryVersion(value, name) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function sanitizeText(value) {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/<[^>]*>/g, "")
    .slice(0, MAX_TEXT_LENGTH);
}

function optionalString(value, name, maxLength = MAX_TEXT_LENGTH) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function parseStatus(output) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("invalid JSON from update manager");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) {
    throw new Error("unsupported update status schema");
  }
  if (!LINUX_STATES.has(value.linuxState)) {
    throw new Error("invalid update status state");
  }
  const expectedKind = COMPATIBILITY_KINDS[value.linuxState];
  if (value.kind !== expectedKind) {
    throw new Error("invalid update status compatibility kind");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: expectedKind,
    linuxState: value.linuxState,
    version: value.version === undefined || value.version === null
      ? undefined
      : strictFactoryVersion(value.version, "version"),
    packagePath: optionalString(value.packagePath, "package path", 4096),
    packageSha256: optionalString(value.packageSha256, "package hash", 64),
    manualCommand: optionalString(value.manualCommand, "manual command", 4096),
    installRequested: value.installRequested === true,
    relaunchPending: value.relaunchPending === true,
    relaunchError: sanitizeText(value.relaunchError),
    message: sanitizeText(value.message),
  });
}

function unavailableState(message = "Factory update manager is unavailable") {
  return Object.freeze({
    schemaVersion: 1,
    kind: "error",
    linuxState: "update-manager-unavailable",
    message,
  });
}

function failedState(message) {
  return Object.freeze({
    schemaVersion: 1,
    kind: "error",
    linuxState: "failed",
    message: sanitizeText(message) || "Factory update manager failed",
  });
}

function defaultRun(args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      HELPER,
      args,
      {
        encoding: "utf8",
        timeout: HELPER_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => error ? reject(error) : resolve(stdout),
    );
  });
}

function defaultSpawn(args) {
  const child = childProcess.spawn(HELPER, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", () => {});
  child.unref();
}

function loadElectron() {
  try {
    return require("electron");
  } catch {
    return {};
  }
}

function createBridge(overrides = {}) {
  const electron = overrides.electron || loadElectron();
  const run = overrides.run || defaultRun;
  const spawn = overrides.spawn || defaultSpawn;
  const helperExists = overrides.helperExists || (() => fs.existsSync(HELPER));
  const dialog = overrides.dialog || electron.dialog;
  const clipboard = overrides.clipboard || electron.clipboard;
  const windows = overrides.windows || electron.BrowserWindow;
  const app = overrides.app || electron.app;
  const pid = overrides.pid || process.pid;
  const schedule = overrides.schedule || ((callback, delay) => setTimeout(callback, delay));
  let previousTransition;
  let startupSyncPromise;
  let startupCheckRequested = false;
  let startupSyncScheduled = false;

  function parentWindow() {
    return windows?.getFocusedWindow?.() || windows?.getAllWindows?.()[0];
  }

  async function runStatus(args) {
    if (!helperExists()) return unavailableState();
    try {
      const state = parseStatus(await run(args));
      if (state.kind === "available") {
        return Object.freeze({
          ...state,
          currentVersion: strictFactoryVersion(app?.getVersion?.(), "current Factory version"),
          latestVersion: strictFactoryVersion(state.version, "latest Factory version"),
        });
      }
      if (state.kind === "downloading" && state.version) {
        return Object.freeze({ ...state, targetVersion: state.version });
      }
      return state;
    } catch (error) {
      return failedState(error?.message);
    }
  }

  async function getState() {
    return runStatus(["status", "--json"]);
  }

  async function checkNow() {
    if (!helperExists()) return unavailableState();
    const current = await getState();
    if (ACTIVE_UPDATE_STATES.has(current.linuxState) || current.linuxState === "ready-pending-exit" || current.linuxState === "installing" ||
        current.linuxState === "install-failed-manual-action" ||
        current.linuxState === "update-manager-unavailable") {
      return current;
    }
    try {
      spawn(["check-now"]);
      return Object.freeze({
        ...current,
        kind: "checking",
        linuxState: "checking",
        message: "Checking Factory Desktop updates",
      });
    } catch (error) {
      return failedState(error?.message);
    }
  }

  async function install() {
    const current = await getState();
    const parent = parentWindow();
    if (current.linuxState === "ready-pending-exit") {
      if (!parent || !dialog?.showMessageBox || !app?.quit) return current;
      const answer = await dialog.showMessageBox(parent, {
        type: "question",
        title: "Install Factory Desktop update",
        message: "Factory Desktop will close, install the validated update, and restart.",
        buttons: ["Install and restart", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (answer.response !== 0) return current;
      const prepared = await runStatus(["prepare-install", "--pid", String(pid)]);
      if (prepared.linuxState === "ready-pending-exit" && prepared.installRequested) app.quit();
      return prepared;
    }
    if (current.linuxState === "install-failed-manual-action" && current.manualCommand) {
      if (!parent || !dialog?.showMessageBox || !clipboard?.writeText) return current;
      const answer = await dialog.showMessageBox(parent, {
        type: "warning",
        title: "Manual update action required",
        message: current.message || "Factory Desktop could not request an authenticated install.",
        detail: current.manualCommand,
        buttons: ["Copy command", "Dismiss"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (answer.response === 0) clipboard.writeText(current.manualCommand);
    }
    return current;
  }

  async function pollOnce() {
    const current = await getState();
    const transition = `${current.linuxState}:${current.version || ""}:${current.packageSha256 || ""}`;
    if (transition === previousTransition) return current;
    previousTransition = transition;
    if (current.linuxState === "failed") {
      const parent = parentWindow();
      if (parent && dialog?.showMessageBox) {
        const answer = await dialog.showMessageBox(parent, {
          type: "error",
          title: "Factory Desktop update rejected",
          message: current.message || "The update candidate was rejected.",
          buttons: ["Retry check", "Dismiss"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (answer.response === 0) {
          const retried = await checkNow();
          if (!startupSyncTerminal(retried)) queueStartupSync(0);
          return retried;
        }
      }
    }
    return current;
  }

  function startupSyncTerminal(state) {
    if (state.linuxState === "idle" && startupCheckRequested) return true;
    return STARTUP_TERMINAL_STATES.has(state.linuxState);
  }

  function queueStartupSync(index) {
    if (startupSyncScheduled) return;
    startupSyncScheduled = true;
    const delay = index > STARTUP_SYNC_DELAYS_MS.length
      ? ACTIVE_POLL_INTERVAL_MS
      : STARTUP_SYNC_DELAYS_MS[Math.min(Math.max(index - 1, 0), STARTUP_SYNC_DELAYS_MS.length - 1)];
    schedule(async () => {
      startupSyncScheduled = false;
      await startupSyncTick(index);
    }, delay);
  }

  async function startupSyncTick(index) {
    let current = await dispatch("getState", {});
    if (current.linuxState === "idle" && !current.version && !startupCheckRequested) {
      startupCheckRequested = true;
      current = await dispatch("checkNow", {});
    }
    if (ACTIVE_UPDATE_STATES.has(current.linuxState)) queueStartupSync(index + 1);
    return current;
  }

  function startBackgroundSync() {
    if (!startupSyncPromise) {
      startupSyncPromise = startupSyncTick(0).catch((error) => failedState(error?.message));
    }
    return startupSyncPromise;
  }

  async function invoke(action, payload = {}) {
    if (!new Set(["getState", "install", "checkNow"]).has(action)) {
      throw new Error("unsupported update bridge action");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 0) {
      throw new Error("invalid update bridge payload");
    }
    if (action === "getState") return getState();
    if (action === "install") return install();
    if (action === "checkNow") return checkNow();
    throw new Error("unsupported update bridge action");
  }

  async function dispatch(action, payload = {}) {
    const state = action === "getState"
      ? await pollOnce()
      : await invoke(action, payload);
    if (action === "checkNow" && !startupSyncTerminal(state)) queueStartupSync(0);
    for (const window of windows?.getAllWindows?.() || []) {
      if (window?.isDestroyed?.()) continue;
      window?.webContents?.send?.("updates:state", state);
    }
    return state;
  }

  return Object.freeze({ getState, checkNow, install, pollOnce, startBackgroundSync, invoke, dispatch });
}

module.exports = Object.freeze({
  HELPER,
  createBridge,
  parseStatus,
});

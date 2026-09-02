"use strict";

const fs = require("node:fs");
const childProcess = require("node:child_process");

const HELPER = "/usr/bin/factory-update-manager";
const HELPER_TIMEOUT_MS = 5000;
const MAX_TEXT_LENGTH = 512;
const STARTUP_SYNC_DELAYS_MS = Object.freeze([250, 1000, 3000, 7000, 15000]);
const ACTIVE_POLL_INTERVAL_MS = 30000;
const ACTIVE_UPDATE_STATES = new Set([
  "checking",
  "downloading",
  "building",
  "validating",
  "installing",
]);
const USER_OPERATION_START_STATES = new Set(["update-available", "ready-to-install"]);
const STARTUP_TERMINAL_STATES = new Set([
  "idle",
  "update-available",
  "ready-to-install",
  "installed",
  "install-failed-manual-action",
  "rolled-back",
  "failed",
  "update-manager-unavailable",
]);
const LINUX_STATES = new Set([
  "idle",
  "checking",
  "update-available",
  "downloading",
  "building",
  "validating",
  "ready-to-install",
  "installing",
  "installed",
  "install-failed-manual-action",
  "rolled-back",
  "failed",
]);
const COMPATIBILITY_KINDS = Object.freeze({
  idle: "idle",
  checking: "checking",
  "update-available": "available",
  downloading: "downloading",
  building: "downloading",
  validating: "downloading",
  "ready-to-install": "available",
  installing: "downloading",
  installed: "idle",
  "install-failed-manual-action": "error",
  "rolled-back": "idle",
  failed: "error",
});
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;


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

function optionalTimestamp(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 64 || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function optionalBoolean(value, name) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new Error(`invalid ${name}`);
  return value;
}

function optionalSha256(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("invalid package hash");
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
    availableVersion: value.availableVersion === undefined || value.availableVersion === null
      ? undefined
      : strictFactoryVersion(value.availableVersion, "available version"),
    updatedAt: optionalTimestamp(value.updatedAt, "updated timestamp"),
    packagePath: optionalString(value.packagePath, "package path", 4096),
    packageSha256: optionalSha256(value.packageSha256),
    manualCommand: optionalString(value.manualCommand, "manual command", 4096),
    installRequested: optionalBoolean(value.installRequested, "install requested"),
    relaunchPending: optionalBoolean(value.relaunchPending, "relaunch pending"),
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
  let updateOperationRequested = false;
  let relaunchArmed = false;
  let exitRequested = false;
  let startupSyncActive = false;

  function parentWindow() {
    return windows?.getFocusedWindow?.() || windows?.getAllWindows?.()[0];
  }

  function transitionKey(state) {
    return [
      state.linuxState,
      state.version || "",
      state.availableVersion || "",
      state.packageSha256 || "",
      state.message || "",
      state.manualCommand || "",
      state.installRequested ? "1" : "0",
      state.relaunchPending ? "1" : "0",
    ].join(":");
  }

  async function runStatus(args) {
    try {
      if (!helperExists()) return unavailableState();
      const state = parseStatus(await run(args));
      if (state.linuxState === "update-available" || state.linuxState === "ready-to-install") {
        const latestVersion = strictFactoryVersion(
          state.availableVersion || state.version,
          "latest Factory version",
        );
        return Object.freeze({
          ...state,
          currentVersion: strictFactoryVersion(app?.getVersion?.(), "current Factory version"),
          availableVersion: state.availableVersion || latestVersion,
          latestVersion,
        });
      }
      if (ACTIVE_UPDATE_STATES.has(state.linuxState) && state.version) {
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
    if (
      updateOperationRequested
      || ACTIVE_UPDATE_STATES.has(current.linuxState)
      || current.linuxState === "ready-to-install"
      || current.linuxState === "install-failed-manual-action"
      || current.linuxState === "update-manager-unavailable"
    ) {
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

  async function showManualAction(current) {
    const parent = parentWindow();
    if (!parent || !dialog?.showMessageBox || !clipboard?.writeText || !current.manualCommand) return;
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

  async function install() {
    const current = await getState();
    if (current.linuxState === "install-failed-manual-action") {
      await showManualAction(current);
      return current;
    }
    if (!USER_OPERATION_START_STATES.has(current.linuxState)) {
      if (ACTIVE_UPDATE_STATES.has(current.linuxState)) queueStartupSync(0);
      return current;
    }
    if (current.installRequested || updateOperationRequested) {
      queueStartupSync(0);
      return current;
    }
    try {
      spawn(["update", "--pid", String(pid)]);
      updateOperationRequested = true;
      relaunchArmed = true;
      queueStartupSync(0);
      return Object.freeze({
        ...current,
        kind: "downloading",
        linuxState: "downloading",
        message: "Preparing Factory Desktop update",
      });
    } catch (error) {
      return failedState(error?.message);
    }
  }

  async function pollOnce() {
    const current = await getState();
    const transition = transitionKey(current);
    if (transition !== previousTransition) {
      previousTransition = transition;
      if (current.linuxState === "failed" && !updateOperationRequested && !startupSyncActive) {
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
    }
    if (relaunchArmed && !exitRequested && current.linuxState === "ready-to-install") {
      exitRequested = true;
      try {
        app?.quit?.();
      } catch {
        // Electron may already be exiting after preparation completed.
      }
    }
    return current;
  }

  function startupSyncTerminal(state) {
    if (relaunchArmed && [
      "update-available",
      "checking",
      "downloading",
      "building",
      "validating",
      "ready-to-install",
      "installing",
    ].includes(state.linuxState)) return false;
    if (state.linuxState === "idle" && startupCheckRequested && !relaunchArmed) return true;
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
    startupSyncActive = true;
    try {
      let current = await dispatch("getState", {});
      if (current.linuxState === "failed") {
        if (index <= STARTUP_SYNC_DELAYS_MS.length) {
          startupCheckRequested = false;
          current = await dispatch("checkNow", {});
        }
      } else if (
        current.linuxState === "idle"
        && !current.version
        && !current.availableVersion
        && !startupCheckRequested
      ) {
        startupCheckRequested = true;
        current = await dispatch("checkNow", {});
      }
      if (current.linuxState === "failed" && index <= STARTUP_SYNC_DELAYS_MS.length) {
        queueStartupSync(index + 1);
      } else if (
        ACTIVE_UPDATE_STATES.has(current.linuxState)
        || (relaunchArmed && !startupSyncTerminal(current))
      ) {
        queueStartupSync(index + 1);
      }
      return current;
    } finally {
      startupSyncActive = false;
    }
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
    if ((action === "checkNow" || action === "install") && !startupSyncTerminal(state)) {
      queueStartupSync(0);
    }
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

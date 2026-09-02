"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createBridge, parseStatus } = require("../packaging/linux/update-bridge.cjs");

const HELPER_AVAILABLE = { helperExists: () => true };

const STATES = {
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
};

function envelope(linuxState, extra = {}) {
  const available = linuxState === "update-available";
  const candidate = !available && !["idle", "checking"].includes(linuxState);
  return JSON.stringify({
    schemaVersion: 1,
    kind: STATES[linuxState],
    linuxState,
    version: candidate ? "0.140.0" : undefined,
    availableVersion: available ? "0.140.0" : undefined,
    updatedAt: "2026-08-28T00:00:00Z",
    packagePath: candidate ? "/safe/factory.deb" : undefined,
    packageSha256: candidate ? "a".repeat(64) : undefined,
    installRequested: false,
    relaunchPending: false,
    ...extra,
  });
}

function noSchedule() {
  return () => {};
}

test("bridge parses every schema-1 Linux state into a compatibility kind", () => {
  for (const [linuxState, kind] of Object.entries(STATES)) {
    const state = parseStatus(envelope(linuxState));
    assert.equal(state.linuxState, linuxState);
    assert.equal(state.kind, kind);
  }
  assert.throws(() => parseStatus(envelope("ready-pending-exit")), /state/);
});

test("metadata update exposes current and available versions", async () => {
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async () => envelope("update-available", { availableVersion: "0.143.0" }),
    app: { getVersion: () => "0.142.0" },
  });

  const state = await bridge.getState();

  assert.equal(state.kind, "available");
  assert.equal(state.linuxState, "update-available");
  assert.equal(state.currentVersion, "0.142.0");
  assert.equal(state.availableVersion, "0.143.0");
  assert.equal(state.latestVersion, "0.143.0");
});

test("bridge rejects invalid JSON, schema, state, fields, and untrusted text", () => {
  assert.throws(() => parseStatus("not json"), /invalid JSON/);
  assert.throws(() => parseStatus(JSON.stringify({ schemaVersion: 2 })), /schema/);
  assert.throws(() => parseStatus(envelope("unknown")), /state/);
  assert.throws(() => parseStatus(envelope("idle", { updatedAt: "not-a-timestamp" })), /timestamp/);
  assert.throws(() => parseStatus(envelope("ready-to-install", { packageSha256: "not-a-hash" })), /hash/);
  const state = parseStatus(envelope("failed", {
    message: `<img src=x onerror=alert(1)>${"x".repeat(2000)}`,
  }));
  assert.doesNotMatch(state.message, /<img/);
  assert.ok(state.message.length <= 512);
});

test("helper missing, timeout, and invalid output fail without crashing", async () => {
  const missing = createBridge({ helperExists: () => false });
  assert.equal((await missing.getState()).linuxState, "update-manager-unavailable");

  const timeout = createBridge({ ...HELPER_AVAILABLE, run: async () => { throw new Error("timed out"); } });
  assert.equal((await timeout.getState()).linuxState, "failed");

  const invalid = createBridge({ ...HELPER_AVAILABLE, run: async () => "{}" });
  assert.equal((await invalid.getState()).linuxState, "failed");
});

test("bridge exposes only whitelisted actions with empty validated payloads", async () => {
  const bridge = createBridge({ ...HELPER_AVAILABLE, run: async () => envelope("idle") });
  await assert.rejects(() => bridge.invoke("exec", { command: "sh" }), /unsupported/);
  await assert.rejects(() => bridge.invoke("getState", { path: "/tmp/evil" }), /payload/);
  assert.equal((await bridge.invoke("getState", {})).linuxState, "idle");
});

test("check now performs a metadata-only detached check", async () => {
  const runs = [];
  const spawns = [];
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async (args) => {
      runs.push(args);
      return envelope("idle");
    },
    spawn: (args) => spawns.push(args),
  });

  const state = await bridge.checkNow();

  assert.equal(state.linuxState, "checking");
  assert.deepEqual(runs, [["status", "--json"]]);
  assert.deepEqual(spawns, [["check-now"]]);
  assert.equal(spawns.some((args) => args[0] === "update"), false);
});

test("check now does not start a duplicate operation while the updater is active", async () => {
  const spawns = [];
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async () => envelope("checking"),
    spawn: (args) => spawns.push(args),
  });

  const state = await bridge.checkNow();

  assert.equal(state.linuxState, "checking");
  assert.deepEqual(spawns, []);
});

test("visible update starts one detached update operation without quitting", async () => {
  const calls = [];
  const spawns = [];
  const scheduled = [];
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async () => envelope("update-available", { availableVersion: "0.143.0" }),
    spawn: (args) => spawns.push(args),
    schedule: (callback, delay) => scheduled.push({ callback, delay }),
    app: {
      getVersion: () => "0.142.0",
      quit: () => calls.push("quit"),
      relaunch: () => calls.push("relaunch"),
    },
    pid: 4242,
  });

  const first = await bridge.install();
  const second = await bridge.install();

  assert.equal(first.linuxState, "downloading");
  assert.equal(first.kind, "downloading");
  assert.deepEqual(spawns, [["update", "--pid", "4242"]]);
  assert.equal(second.linuxState, "update-available");
  assert.deepEqual(calls, []);
  assert.ok(scheduled.length >= 1);
});

test("ready-to-install exits once for the active user operation", async () => {
  const calls = [];
  const statuses = [
    envelope("update-available", { availableVersion: "0.143.0" }),
    envelope("building", { version: "0.143.0" }),
    envelope("ready-to-install", { version: "0.143.0", packageSha256: "b".repeat(64) }),
    envelope("ready-to-install", { version: "0.143.0", packageSha256: "b".repeat(64) }),
  ];
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async () => statuses.shift(),
    spawn: () => {},
    schedule: noSchedule(),
    app: {
      getVersion: () => "0.142.0",
      quit: () => calls.push("quit"),
      relaunch: () => calls.push("relaunch"),
    },
    pid: 4242,
  });

  await bridge.install();
  assert.deepEqual(calls, []);
  assert.equal((await bridge.pollOnce()).linuxState, "building");
  assert.equal((await bridge.pollOnce()).linuxState, "ready-to-install");
  assert.equal((await bridge.pollOnce()).linuxState, "ready-to-install");

  assert.deepEqual(calls, ["quit"]);
});

test("persisted installed or rolled-back state does not exit or relaunch a new bridge", async () => {
  for (const linuxState of ["installed", "rolled-back"]) {
    const calls = [];
    const bridge = createBridge({
      ...HELPER_AVAILABLE,
      run: async () => envelope(linuxState),
      schedule: noSchedule(),
      app: {
        getVersion: () => "0.142.0",
        quit: () => calls.push("quit"),
        relaunch: () => calls.push("relaunch"),
      },
    });

    assert.equal((await bridge.pollOnce()).linuxState, linuxState);
    assert.deepEqual(calls, []);
  }
});

test("manual dialog copies command only and never starts or quits", async () => {
  const calls = [];
  const copied = [];
  const parent = { id: 9 };
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async () => envelope("install-failed-manual-action", {
      manualCommand: "sudo factory-update-manager reconcile-install",
    }),
    dialog: { showMessageBox: async (window, options) => {
      assert.equal(window, parent);
      assert.deepEqual(options.buttons, ["Copy command", "Dismiss"]);
      return { response: 0 };
    } },
    clipboard: { writeText: (value) => copied.push(value) },
    windows: { getFocusedWindow: () => parent, getAllWindows: () => [parent] },
    app: { quit: () => calls.push("quit"), relaunch: () => calls.push("relaunch") },
    schedule: noSchedule(),
  });

  await bridge.install();

  assert.deepEqual(copied, ["sudo factory-update-manager reconcile-install"]);
  assert.deepEqual(calls, []);
});

test("failed transition offers one explicit retry dialog, not a retry loop", async () => {
  let dialogs = 0;
  const calls = [];
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async (args) => { calls.push(args); return envelope("failed", { message: "Rejected" }); },
    dialog: { showMessageBox: async () => { dialogs += 1; return { response: 1 }; } },
    windows: { getFocusedWindow: () => ({ id: 1 }), getAllWindows: () => [] },
    schedule: noSchedule(),
  });

  await bridge.pollOnce();
  await bridge.pollOnce();

  assert.equal(dialogs, 1);
  assert.equal(calls.filter((args) => args[0] === "check-now").length, 0);
});

test("dispatch broadcasts only validated state through updates:state", async () => {
  const messages = [];
  const window = {
    isDestroyed: () => false,
    webContents: { send: (channel, state) => messages.push([channel, state]) },
  };
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async () => envelope("checking"),
    windows: { getAllWindows: () => [window] },
  });

  const state = await bridge.dispatch("getState", {});

  assert.equal(state.linuxState, "checking");
  assert.deepEqual(messages, [["updates:state", state]]);
});

test("startup sync checks metadata once and publishes update-available without preparing", async () => {
  const scheduled = [];
  const spawns = [];
  const messages = [];
  const window = {
    isDestroyed: () => false,
    webContents: { send: (channel, state) => messages.push([channel, state.linuxState]) },
  };
  let statusCalls = 0;
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async () => {
      statusCalls += 1;
      return statusCalls <= 2
        ? envelope("idle")
        : envelope("update-available", { availableVersion: "0.162.0" });
    },
    spawn: (args) => spawns.push(args),
    windows: { getAllWindows: () => [window] },
    app: { getVersion: () => "0.161.0" },
    schedule: (callback, delay) => scheduled.push({ callback, delay }),
  });

  const first = await bridge.startBackgroundSync();

  assert.equal(first.linuxState, "checking");
  assert.deepEqual(spawns, [["check-now"]]);
  assert.deepEqual(messages, [["updates:state", "idle"], ["updates:state", "checking"]]);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 250);

  await scheduled.shift().callback();

  assert.deepEqual(messages.at(-1), ["updates:state", "update-available"]);
  assert.deepEqual(spawns, [["check-now"]]);
  assert.equal(spawns.some((args) => args[0] === "update"), false);
});

test("startup sync retries a transient metadata failure without showing an error dialog", async () => {
  const scheduled = [];
  const spawns = [];
  let statusCalls = 0;
  let dialogs = 0;
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async () => {
      statusCalls += 1;
      return statusCalls < 3
        ? envelope("failed", { message: "metadata check failed: network unavailable" })
        : envelope("update-available", { availableVersion: "0.143.0" });
    },
    spawn: (args) => spawns.push(args),
    dialog: { showMessageBox: async () => { dialogs += 1; return { response: 1 }; } },
    windows: { getFocusedWindow: () => ({ id: 1 }), getAllWindows: () => [] },
    app: { getVersion: () => "0.142.0" },
    schedule: (callback, delay) => scheduled.push({ callback, delay }),
  });

  const first = await bridge.startBackgroundSync();

  assert.equal(first.linuxState, "checking");
  assert.deepEqual(spawns, [["check-now"]]);
  assert.equal(dialogs, 0);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 250);

  await scheduled.shift().callback();

  assert.equal(statusCalls, 3);
  assert.equal(dialogs, 0);
  assert.equal(spawns.length, 1);
});

test("long-running active updates continue with bounded helper polls", async () => {
  const scheduled = [];
  let calls = 0;
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async () => {
      calls += 1;
      return envelope("building");
    },
    windows: { getAllWindows: () => [] },
    schedule: (callback, delay) => scheduled.push({ callback, delay }),
  });

  await bridge.startBackgroundSync();
  assert.equal(scheduled.length, 1);
  await scheduled.shift().callback();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1000);

  for (let index = 0; index < 4; index += 1) {
    await scheduled.shift().callback();
  }

  assert.equal(calls > 5, true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 30000);
});

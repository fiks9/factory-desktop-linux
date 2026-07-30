"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createBridge, parseStatus } = require("../packaging/linux/update-bridge.cjs");

const HELPER_AVAILABLE = { helperExists: () => true };

const STATES = {
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
};

function envelope(linuxState, extra = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    kind: STATES[linuxState],
    linuxState,
    version: "0.140.0",
    packagePath: "/safe/factory.deb",
    packageSha256: "a".repeat(64),
    ...extra,
  });
}

test("bridge parses every schema-1 Rust state into a compatibility kind", () => {
  for (const [linuxState, kind] of Object.entries(STATES)) {
    const state = parseStatus(envelope(linuxState));
    assert.equal(state.linuxState, linuxState);
    assert.equal(state.kind, kind);
  }
});

test("bridge rejects invalid JSON, schema, state, and untrusted text", () => {
  assert.throws(() => parseStatus("not json"), /invalid JSON/);
  assert.throws(() => parseStatus(JSON.stringify({ schemaVersion: 2 })), /schema/);
  assert.throws(() => parseStatus(envelope("unknown")), /state/);
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

test("check now detaches the long-running updater instead of timing out the build", async () => {
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
});

test("retry check is available only from a failed state and starts one detached check", async () => {
  const spawns = [];
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async () => envelope("failed", { message: "Rejected" }),
    spawn: (args) => spawns.push(args),
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    windows: { getFocusedWindow: () => ({ id: 1 }), getAllWindows: () => [] },
  });

  await bridge.pollOnce();

  assert.deepEqual(spawns, [["check-now"]]);
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

test("ready install requires a parented confirmation then prepares and quits", async () => {
  const calls = [];
  const parent = { id: 7 };
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async (args) => {
      calls.push(args);
      return args[0] === "status" ? envelope("ready-pending-exit") : envelope("ready-pending-exit", { installRequested: true });
    },
    dialog: { showMessageBox: async (window, options) => {
      assert.equal(window, parent);
      assert.deepEqual(options.buttons, ["Install and restart", "Cancel"]);
      return { response: 0 };
    } },
    windows: { getFocusedWindow: () => parent, getAllWindows: () => [parent] },
    app: { quit: () => calls.push(["app.quit"]) },
    pid: 4242,
  });

  await bridge.install();

  assert.deepEqual(calls[1], ["prepare-install", "--pid", "4242"]);
  assert.deepEqual(calls[2], ["app.quit"]);
});

test("manual dialog copies command only and dismiss does not discard candidate", async () => {
  const calls = [];
  const copied = [];
  const parent = { id: 9 };
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async (args) => {
      calls.push(args);
      return envelope("install-failed-manual-action", { manualCommand: "sudo factory-update-manager reconcile-install" });
    },
    dialog: { showMessageBox: async (window, options) => {
      assert.equal(window, parent);
      assert.deepEqual(options.buttons, ["Copy command", "Dismiss"]);
      return { response: 0 };
    } },
    clipboard: { writeText: (value) => copied.push(value) },
    windows: { getFocusedWindow: () => parent, getAllWindows: () => [parent] },
  });

  await bridge.install();

  assert.deepEqual(copied, ["sudo factory-update-manager reconcile-install"]);
  assert.equal(calls.length, 1);
});

test("failed transition offers one retry dialog, not one per poll", async () => {
  let dialogs = 0;
  const calls = [];
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async (args) => { calls.push(args); return envelope("failed", { message: "Rejected" }); },
    dialog: { showMessageBox: async () => { dialogs += 1; return { response: 1 }; } },
    windows: { getFocusedWindow: () => ({ id: 1 }), getAllWindows: () => [] },
  });

  await bridge.pollOnce();
  await bridge.pollOnce();

  assert.equal(dialogs, 1);
  assert.equal(calls.filter((args) => args[0] === "check-now").length, 0);
});

test("status IPC presents a failed transition once", async () => {
  let dialogs = 0;
  const bridge = createBridge({
    ...HELPER_AVAILABLE,
    run: async () => envelope("failed", { message: "Rejected" }),
    dialog: { showMessageBox: async () => { dialogs += 1; return { response: 1 }; } },
    windows: { getFocusedWindow: () => ({ id: 1 }), getAllWindows: () => [] },
  });

  await bridge.dispatch("getState", {});
  await bridge.dispatch("getState", {});

  assert.equal(dialogs, 1);
});

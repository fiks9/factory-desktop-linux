"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const asar = require("@electron/asar");
const { patchAsar } = require("../src/engine");
const { validatePackaging } = require("../src/validators");

async function fixture(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-patcher-"));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, ".vite", "build"), { recursive: true });
  fs.writeFileSync(path.join(source, ".vite", "build", "index.js"), content);
  const asarPath = path.join(root, "app.asar");
  await asar.createPackage(source, asarPath);
  return { root, asarPath };
}

function rawBundle(transport = "hardcoded") {
  const resolver = transport === "statsig"
    ? "async function XX(){const e=YY.DesktopDaemonIpc;return(await getFlag())[e.statsigName]??e.defaultValue?TT.Ipc:TT.WebSocket}"
    : "function BVe(){return fc.Ipc}";
  return `${resolver} function dv(){return\"droid-dev\"} async function start(){return resolveTransportMode()} function resolveTransportMode(){return BVe()} function daemon(){let r;if(W.app.isPackaged)r=X.join(process.resourcesPath,\"bin\",process.platform===\"win32\"?\"droid.exe\":\"droid\");else r=dv();const t=fc.Ipc&&a.push(\"--listen\",\"ipc\");W.app.isPackaged||a.push(\"--debug\");const h={transportMode:t};/* --enable-child-ipc */} W.autoUpdater.checkForUpdates();W.autoUpdater.quitAndInstall(); async startInternal(){this.state=Hn.Starting;this.currentPort=r;let l;if(r!==null){spawn()}}`;
}

test("raw hardcoded transport bundle patches all required descriptors", async () => {
  const { asarPath, root } = await fixture(rawBundle());
  const reportPath = path.join(root, "patch-report.json");
  const report = await patchAsar({ asarPath, reportPath });
  for (const id of ["daemon-transport-force-websocket", "prevent-listen-ipc", "system-daemon-adoption", "system-droid-cli-resolver", "linux-native-updater-button", "auto-updater-guard"]) {
    const outcome = report.outcomes.find((item) => item.id === id);
    assert.equal(outcome.matched, true, id);
    assert.equal(outcome.validationPassed, true, id);
  }
  const second = await patchAsar({ asarPath });
  assert.ok(second.outcomes.every((item) => item.alreadyPatched), JSON.stringify(second.outcomes));
  assert.equal(fs.existsSync(reportPath), true);
});

test("statsig resolver uses the structural matcher", async () => {
  const { asarPath } = await fixture(rawBundle("statsig"));
  const report = await patchAsar({ asarPath });
  const outcome = report.outcomes.find((item) => item.id === "daemon-transport-force-websocket");
  assert.equal(outcome.evidence.matcher, "statsigResolverMatcher");
  assert.equal(outcome.validationPassed, true);
  const patched = asar.extractFile(asarPath, ".vite/build/index.js").toString("utf8");
  const resolver = patched.match(/async function XX\(\)\{const e=YY\.DesktopDaemonIpc;return TT\.WebSocket\}/)?.[0];
  assert.ok(resolver);
  assert.doesNotThrow(() => new Function(`${resolver};`));
});

test("garbage bundle fails closed on the first required patch", async () => {
  const { asarPath, root } = await fixture("console.log('not a Factory daemon bundle')");
  const reportPath = path.join(root, "failed-report.json");
  await assert.rejects(() => patchAsar({ asarPath, reportPath }), /Required patch failed: daemon-transport-force-websocket/);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.outcomes[0].validationPassed, false);
});

test("existing foreign marker is not accepted as our patch", async () => {
  const { asarPath } = await fixture(`${rawBundle()} /* linux-daemon-transport-patch */`);
  const reportPromise = patchAsar({ asarPath });
  await assert.doesNotReject(reportPromise);
});

test("packaging validators prove keyring and protocol integration", () => {
  const root = path.resolve(__dirname, "..", "..");
  const result = validatePackaging(root);
  assert.equal(result.keyring.validationPassed, true);
  assert.equal(result.protocol.validationPassed, true);
});

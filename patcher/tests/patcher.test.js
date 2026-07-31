"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const asar = require("@electron/asar");
const { sha256File } = require("../src/asar-io");
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
  return `${resolver} function dv(){return\"droid-dev\"} async function start(){return resolveTransportMode()} function resolveTransportMode(){return BVe()} function daemon(){let r;if(W.app.isPackaged)r=X.join(process.resourcesPath,\"bin\",process.platform===\"win32\"?\"droid.exe\":\"droid\");else r=dv();const t=fc.Ipc&&a.push(\"--listen\",\"ipc\");W.app.isPackaged||a.push(\"--debug\");const h={transportMode:t};/* --enable-child-ipc */} const win32=process.platform===\"win32\",factoryWindow=new W.BrowserWindow({titleBarStyle:win32?\"default\":\"hidden\",trafficLightPosition:win32?void 0:{x:12,y:10},webPreferences:{}});const factoryContents=factoryWindow.webContents;W.ipcMain.handle(\"updates:getState\",async()=>legacyGetState());W.ipcMain.handle(\"updates:install\",async()=>legacyInstall());W.ipcMain.handle(\"updates:checkNow\",async()=>legacyCheckNow());W.autoUpdater.checkForUpdates();W.autoUpdater.quitAndInstall(); const daemonController={async startInternal(){this.state=Hn.Starting;this.currentPort=r;let l;if(r!==null){spawn()}}}`;
}

function legacyStaticWindowBundle() {
  return rawBundle().replace(
    'titleBarStyle:win32?"default":"hidden",trafficLightPosition:win32?void 0:{x:12,y:10},',
    'titleBarStyle:win32?"default":"hidden",/* factory-linux:linux-window-controls */titleBarOverlay:process.platform==="linux"?{color:"#171717",symbolColor:"#f5f5f5",height:30}:void 0,icon:process.platform==="linux"?process.resourcesPath+"/factory-desktop.png":void 0,trafficLightPosition:win32?void 0:{x:12,y:10},',
  );
}

function commaExpressionBundle() {
  return rawBundle().replace(
    'W.ipcMain.handle("updates:getState",async()=>legacyGetState());W.ipcMain.handle("updates:install",async()=>legacyInstall());W.ipcMain.handle("updates:checkNow",async()=>legacyCheckNow());',
    'function updates(){return(W.ipcMain.handle("updates:getState",async()=>legacyGetState()),W.ipcMain.handle("updates:install",async()=>legacyInstall()),W.ipcMain.handle("updates:checkNow",async()=>legacyCheckNow()),true)}',
  );
}

test("raw hardcoded transport bundle patches all required descriptors", async () => {
  const { asarPath, root } = await fixture(rawBundle());
  const reportPath = path.join(root, "patch-report.json");
  const report = await patchAsar({ asarPath, reportPath });
  for (const id of ["daemon-transport-force-websocket", "prevent-listen-ipc", "system-daemon-adoption", "system-droid-cli-resolver", "linux-window-controls", "linux-native-updater-button", "auto-updater-guard"]) {
    const outcome = report.outcomes.find((item) => item.id === id);
    assert.equal(outcome.matched, true, id);
    assert.equal(outcome.validationPassed, true, id);
  }
  const second = await patchAsar({ asarPath });
  assert.ok(second.outcomes.every((item) => item.alreadyPatched), JSON.stringify(second.outcomes));
  assert.equal(fs.existsSync(reportPath), true);
});

test("patching preserves original unpacked ASAR files and companion tree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-patcher-unpacked-"));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, ".vite", "build", "native"), { recursive: true });
  fs.writeFileSync(path.join(source, ".vite", "build", "index.js"), rawBundle());
  fs.writeFileSync(path.join(source, ".vite", "build", "native", "keytar.node"), "native-module");
  const asarPath = path.join(root, "app.asar");
  await asar.createPackageWithOptions(source, asarPath, { unpack: path.join(source, ".vite", "build", "native", "keytar.node") });

  await patchAsar({ asarPath });

  const unpackedEntries = asar.listPackage(asarPath, { isPack: true }).filter((entry) => entry.startsWith("unpack : "));
  assert.deepEqual(unpackedEntries, ["unpack : /.vite/build/native/keytar.node"]);
  assert.equal(fs.readFileSync(path.join(`${asarPath}.unpacked`, ".vite", "build", "native", "keytar.node"), "utf8"), "native-module");
  assert.doesNotThrow(() => asar.extractAll(asarPath, path.join(root, "reextracted")));
});

test("Linux window controls patch follows Factory nativeTheme and cleans up its listener", async () => {
  const { asarPath } = await fixture(rawBundle());

  const report = await patchAsar({ asarPath });
  const outcome = report.outcomes.find((item) => item.id === "linux-window-controls");
  const patched = asar.extractFile(asarPath, ".vite/build/index.js").toString("utf8");

  assert.equal(outcome.matched, true);
  assert.equal(outcome.validationPassed, true);
  assert.equal((patched.match(/\/\* factory-linux:linux-window-controls \*\//g) || []).length, 1);
  assert.equal((patched.match(/titleBarOverlay:process\.platform===\"linux\"/g) || []).length, 1);
  assert.equal((patched.match(/\/\* factory-linux:linux-window-controls-theme-sync \*\//g) || []).length, 1);
  assert.equal((patched.match(/\/\* factory-linux:linux-window-controls-theme-sync-end \*\//g) || []).length, 1);
  assert.match(patched, /color:W\.nativeTheme\.shouldUseDarkColors\?"#161413":"#f2f0f0"/);
  assert.match(patched, /symbolColor:W\.nativeTheme\.shouldUseDarkColors\?"#f2f0f0":"#000000"/);
  assert.match(patched, /factoryWindow\.setTitleBarOverlay\(/);
  assert.match(patched, /W\.nativeTheme\.on\("updated",factoryLinuxApplyWindowControlsTheme\)/);
  assert.match(patched, /W\.nativeTheme\.removeListener\("updated",factoryLinuxApplyWindowControlsTheme\)/);
  assert.doesNotMatch(patched, /color:"#171717",symbolColor:"#f5f5f5"/);
  assert.equal((patched.match(/icon:process\.platform===\"linux\"\?process\.resourcesPath\+\"\/factory-desktop\.png\"/g) || []).length, 1);
  assert.doesNotMatch(patched, /titleBarStyle:win32\?"default":"hidden",trafficLightPosition/);

  const runtimeStart = patched.indexOf("/* factory-linux:linux-window-controls-theme-sync */");
  const runtimeEnd = patched.indexOf("/* factory-linux:linux-window-controls-theme-sync-end */", runtimeStart);
  assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart);
  const runtime = patched.slice(runtimeStart, runtimeEnd);
  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColors = false;
  const overlays = [];
  let closed;
  const factoryWindow = {
    isDestroyed: () => false,
    setTitleBarOverlay: (overlay) => overlays.push(overlay),
    once: (event, listener) => { if (event === "closed") closed = listener; },
  };
  new Function("W", "factoryWindow", runtime)({ nativeTheme }, factoryWindow);
  assert.deepEqual(overlays.at(-1), { color: "#f2f0f0", symbolColor: "#000000", height: 26 });
  nativeTheme.shouldUseDarkColors = true;
  nativeTheme.emit("updated");
  assert.deepEqual(overlays.at(-1), { color: "#161413", symbolColor: "#f2f0f0", height: 26 });
  closed();
  const countAfterClose = overlays.length;
  nativeTheme.emit("updated");
  assert.equal(overlays.length, countAfterClose);

  const second = await patchAsar({ asarPath });
  const secondOutcome = second.outcomes.find((item) => item.id === "linux-window-controls");
  assert.equal(secondOutcome.alreadyPatched, true);
  assert.equal(secondOutcome.validationPassed, true);
});

test("Linux window controls patch migrates the legacy static overlay", async () => {
  const { asarPath } = await fixture(legacyStaticWindowBundle());

  const report = await patchAsar({ asarPath });
  const outcome = report.outcomes.find((item) => item.id === "linux-window-controls");
  const patched = asar.extractFile(asarPath, ".vite/build/index.js").toString("utf8");

  assert.equal(outcome.matched, true);
  assert.equal(outcome.patched, true);
  assert.equal(outcome.validationPassed, true);
  assert.match(patched, /factory-linux:linux-window-controls-theme-sync/);
  assert.doesNotMatch(patched, /color:"#171717",symbolColor:"#f5f5f5"/);
});

test("Linux window controls patch fails closed when the BrowserWindow contract drifts", async () => {
  const drifted = rawBundle().replace(
    'trafficLightPosition:win32?void 0:{x:12,y:10}',
    'trafficLightPosition:win32?void 0:{x:16,y:12}',
  );
  const { asarPath } = await fixture(drifted);

  await assert.rejects(() => patchAsar({ asarPath }), /linux-window-controls/);
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

test("native updater patch loads the package bridge once and replaces all IPC handlers", async () => {
  const { asarPath } = await fixture(rawBundle());
  await patchAsar({ asarPath });
  const patched = asar.extractFile(asarPath, ".vite/build/index.js").toString("utf8");
  assert.equal((patched.match(/\/usr\/lib\/factory-desktop\/update-bridge\.cjs/g) || []).length, 1);
  assert.match(patched, /FACTORY_UPDATE_MANAGER_UNAVAILABLE/);
  assert.match(patched, /linuxState:"update-manager-unavailable"/);
  for (const action of ["getState", "install", "checkNow"]) {
    assert.equal((patched.match(new RegExp(`\\.dispatch\\(\\"${action}\\"`, "g")) || []).length, 1, action);
  }
  assert.doesNotMatch(patched, /legacy(?:GetState|Install|CheckNow)/);
});

test("native updater patch remains valid inside a comma-expression", async () => {
  const source = commaExpressionBundle();
  assert.doesNotThrow(() => new vm.Script(source, { filename: "upstream-index.js" }));
  const { asarPath } = await fixture(source);
  await patchAsar({ asarPath });
  const patched = asar.extractFile(asarPath, ".vite/build/index.js").toString("utf8");

  assert.doesNotThrow(() => new vm.Script(patched, { filename: "index.js" }));
});

test("native updater patch fails closed when the IPC contract drifts", async () => {
  const missing = rawBundle().replace('W.ipcMain.handle("updates:install",async()=>legacyInstall());', "");
  const missingFixture = await fixture(missing);
  await assert.rejects(() => patchAsar({ asarPath: missingFixture.asarPath }), /linux-native-updater-button/);

  const duplicate = rawBundle().replace(
    'W.ipcMain.handle("updates:getState",async()=>legacyGetState());',
    'W.ipcMain.handle("updates:getState",async()=>legacyGetState());W.ipcMain.handle("updates:getState",async()=>duplicateState());',
  );
  const duplicateFixture = await fixture(duplicate);
  await assert.rejects(() => patchAsar({ asarPath: duplicateFixture.asarPath }), /linux-native-updater-button/);

  const interleaved = rawBundle().replace(
    'W.ipcMain.handle("updates:getState",async()=>legacyGetState());W.ipcMain.handle("updates:install",async()=>legacyInstall());',
    'W.ipcMain.handle("updates:getState",async()=>legacyGetState());unrelatedSideEffect();W.ipcMain.handle("updates:install",async()=>legacyInstall());',
  );
  const interleavedFixture = await fixture(interleaved);
  await assert.rejects(() => patchAsar({ asarPath: interleavedFixture.asarPath }), /linux-native-updater-button/);
});

test("native updater patch rejects a foreign partial marker", async () => {
  const partial = rawBundle().replace(
    'W.ipcMain.handle("updates:getState",async()=>legacyGetState());',
    '/* factory-linux:linux-native-updater-button */W.ipcMain.handle("updates:getState",async()=>legacyGetState());',
  );
  const { asarPath } = await fixture(partial);
  await assert.rejects(() => patchAsar({ asarPath }), /linux-native-updater-button/);
});

test("syntax gate rejects a marker-bearing invalid complete bundle", () => {
  const { validateJavaScriptFiles } = require("../src/javascript-syntax");
  const validation = validateJavaScriptFiles([
    { path: ".vite/build/index.js", content: '(()=>0),/* factory-linux:test */const broken=1' },
  ], { changedPaths: new Set() });

  assert.equal(validation.validationPassed, false);
  assert.equal(validation.evidence.checkedFiles, 1);
  assert.match(validation.errors[0], /index\.js.*Unexpected token/);
});

test("patch engine rejects invalid complete syntax before replacing the ASAR", async () => {
  const invalid = `${rawBundle()}function broken(){return(0),/* factory-linux:foreign-regression */const value=1}`;
  const { asarPath, root } = await fixture(invalid);
  const reportPath = path.join(root, "failed-syntax-report.json");
  const originalHash = sha256File(asarPath);

  await assert.rejects(() => patchAsar({ asarPath, reportPath }), /bundle-javascript-syntax/);

  assert.equal(sha256File(asarPath), originalHash);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const outcome = report.outcomes.find((item) => item.id === "bundle-javascript-syntax");
  assert.equal(outcome.validationPassed, false);
  assert.equal(report.changed, false);
  assert.equal(report.finalHash, originalHash);
});

test("critical patch drift exposes only bounded diagnostic excerpts", async () => {
  const drifted = rawBundle().replace('W.ipcMain.handle("updates:install",async()=>legacyInstall());', "");
  const { asarPath } = await fixture(drifted);
  await assert.rejects(async () => {
    try {
      await patchAsar({ asarPath });
    } catch (error) {
      assert.ok(Array.isArray(error.excerpts));
      assert.ok(error.excerpts.length > 0);
      assert.ok(error.excerpts.every((entry) => entry.text.length <= 1024));
      assert.match(error.excerpts.map((entry) => entry.text).join("\n"), /updates:getState/);
      throw error;
    }
  }, /linux-native-updater-button/);
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
  assert.equal(result.protocol.evidence.startupWmClass, "factory");
  assert.equal(result.protocol.evidence.gnomeWmClass, "factory");
  assert.equal(result.protocol.evidence.desktopHints, true);
});

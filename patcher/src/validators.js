"use strict";

function contextHas(content, marker) {
  return content.includes(marker);
}

function validateTransport(files) {
  const all = files.map((file) => file.content).join("\n");
  const marker = "/* factory-linux:daemon-transport-force-websocket */";
  const hasWebSocket = /\.[Ww]ebSocket\b/.test(all);
  const hardcodedIpc = /function\s+[\w$]+\(\)\{return\s+[\w$]+\.Ipc\}/.test(all);
  const statsigIpc = /DesktopDaemonIpc[\s\S]{0,3000}\?[\w$]+\.Ipc:[\w$]+\.WebSocket/.test(all);
  const hasResolverUse = /resolveTransportMode\(\)/.test(all) && /transportMode/.test(all);
  const validationPassed = contextHas(all, marker) && hasWebSocket && !hardcodedIpc && !statsigIpc && hasResolverUse;
  return {
    validationPassed,
    evidence: { hasWebSocket, hardcodedIpc, statsigIpc, hasResolverUse, marker: contextHas(all, marker) },
    errors: validationPassed ? [] : ["Transport validator could not prove Linux resolver returns WebSocket."],
  };
}

function validateListenIpc(files) {
  const all = files.map((file) => file.content).join("\n");
  const marker = "/* factory-linux:prevent-listen-ipc */";
  const push = /push\("--listen","ipc"\)/.test(all);
  const guarded = /process\.platform!==["']linux["'][^;]{0,100}push\("--listen","ipc"\)/.test(all);
  const validationPassed = contextHas(all, marker) && (!push || guarded);
  return { validationPassed, evidence: { marker: contextHas(all, marker), push, guarded }, errors: validationPassed ? [] : ["An unguarded --listen ipc path remains on Linux."] };
}

function validateAdoption(files) {
  const all = files.map((file) => file.content).join("\n");
  const marker = "/* factory-linux:system-daemon-adoption */";
  const waitMs = all.match(/FACTORY_DAEMON_ADOPTION_TIMEOUT_MS[^0-9]*(\d+)/)?.[1];
  const linuxBranch = all.includes("process.platform!==\"linux\"") || all.includes("process.platform !== \"linux\"");
  const validationPassed = contextHas(all, marker) && all.includes("http://127.0.0.1:37643/health") && all.includes("factory-droid-daemon.service") && Number(waitMs) >= 15000 && all.includes("fetch(") && linuxBranch;
  return { validationPassed, evidence: { marker: contextHas(all, marker), healthUrl: all.includes("http://127.0.0.1:37643/health"), systemctl: all.includes("factory-droid-daemon.service"), timeoutMs: Number(waitMs || 0) }, errors: validationPassed ? [] : ["System daemon adoption validator requires health, systemctl fallback, and a >=15s wait."] };
}

function validateSystemDroid(files) {
  const all = files.map((file) => file.content).join("\n");
  const marker = "/* factory-linux:system-droid-cli-resolver */";
  const homePath = all.includes('path.join(os.homedir(),".local","bin","droid")');
  const systemPaths = all.includes("/usr/local/bin/droid") && all.includes("/usr/bin/droid");
  const validationPassed = contextHas(all, marker) && all.includes("FACTORY_DROID_PATH") && all.includes("command -v droid") && homePath && systemPaths && all.includes("Droid CLI not found") && all.includes("[factory-linux] droid CLI");
  return { validationPassed, evidence: { marker: contextHas(all, marker), env: all.includes("FACTORY_DROID_PATH"), commandV: all.includes("command -v droid"), homePath, systemPaths, logging: all.includes("[factory-linux] droid CLI") }, errors: validationPassed ? [] : ["System droid resolver validator did not find all required lookup paths."] };
}

function validateAutoUpdater(files) {
  const all = files.map((file) => file.content).join("\n");
  const marker = "/* factory-linux:auto-updater-guard */";
  const calls = [...all.matchAll(/[\w$]+\.autoUpdater\.(?:checkForUpdates|quitAndInstall)\(\)/g)];
  const unguarded = calls.filter((call) => !all.slice(Math.max(0, call.index - 500), call.index).includes('process.platform!=="linux"'));
  const remaining = unguarded.length > 0;
  const validationPassed = contextHas(all, marker) && !remaining;
  return { validationPassed, evidence: { marker: contextHas(all, marker), remaining }, errors: validationPassed ? [] : ["Built-in autoUpdater calls remain unguarded or unpatched."] };
}

function validateNativeUpdater(files) {
  const all = files.map((file) => file.content).join("\n");
  const marker = "/* factory-linux:linux-native-updater-button */";
  const markerCount = (all.match(/\/\* factory-linux:linux-native-updater-button \*\//g) || []).length;
  const bridgeLoads = (all.match(/require\("\/usr\/lib\/factory-desktop\/update-bridge\.cjs"\)/g) || []).length;
  const handlers = Object.fromEntries(["getState", "install", "checkNow"].map((action) => [
    action,
    (all.match(new RegExp(`factoryLinuxUpdateBridge\\.dispatch\\("${action}",\\{\\}\\)`, "g")) || []).length,
  ]));
  const oldHandlers = ["getState", "install", "checkNow"].some((action) => {
    const pattern = new RegExp(`ipcMain\\.handle\\((["'])updates:${action}\\1\\s*,(?!\\(\\)=>factoryLinuxUpdateBridge\\.dispatch)`);
    return pattern.test(all);
  });
  const appImageFallback = all.includes('FACTORY_UPDATE_MANAGER_UNAVAILABLE==="1"')
    && all.includes('linuxState:"update-manager-unavailable"');
  const expressionIife = all.includes(`${marker}(()=>{const factoryLinuxUpdateBridge=`)
    && /factoryLinuxUpdateBridge\.dispatch\("checkNow",\{\}\)\)\}\)\(\)/.test(all);
  const handlerCount = Object.values(handlers).reduce((sum, count) => sum + count, 0);
  const validationPassed = markerCount === 1
    && bridgeLoads === 1
    && Object.values(handlers).every((count) => count === 1)
    && handlerCount === 3
    && !oldHandlers
    && appImageFallback
    && expressionIife
    && !all.includes("FACTORY_UPDATE_MANAGER_PATH");
  return {
    validationPassed,
    evidence: { marker: contextHas(all, marker), markerCount, bridgeLoads, handlers, handlerCount, oldHandlers, appImageFallback, expressionIife, fixedPath: !all.includes("FACTORY_UPDATE_MANAGER_PATH") },
    errors: validationPassed ? [] : ["Linux native updater bridge or required IPC handler contract was not validated."],
  };
}

function validateWindowControls(files) {
  const all = files.map((file) => file.content).join("\n");
  const markerCount = (all.match(/\/\* factory-linux:linux-window-controls \*\//g) || []).length;
  const syncMarkerCount = (all.match(/\/\* factory-linux:linux-window-controls-theme-sync \*\//g) || []).length;
  const syncEndMarkerCount = (all.match(/\/\* factory-linux:linux-window-controls-theme-sync-end \*\//g) || []).length;
  const overlays = [...all.matchAll(/titleBarOverlay:process\.platform==="linux"\?\{color:([A-Za-z_$][\w$]*)\.nativeTheme\.shouldUseDarkColors\?"#161413":"#f2f0f0",symbolColor:\1\.nativeTheme\.shouldUseDarkColors\?"#f2f0f0":"#000000",height:26\}:void 0/g)];
  const runtime = all.match(/const factoryLinuxApplyWindowControlsTheme=\(\)=>\{if\(([A-Za-z_$][\w$]*)\.isDestroyed\(\)\)return;const factoryLinuxDarkTheme=([A-Za-z_$][\w$]*)\.nativeTheme\.shouldUseDarkColors;\1\.setTitleBarOverlay\(\{color:factoryLinuxDarkTheme\?"#161413":"#f2f0f0",symbolColor:factoryLinuxDarkTheme\?"#f2f0f0":"#000000",height:26\}\)\};if\(process\.platform==="linux"\)\{factoryLinuxApplyWindowControlsTheme\(\);\2\.nativeTheme\.on\("updated",factoryLinuxApplyWindowControlsTheme\);\1\.once\("closed",\(\)=>\2\.nativeTheme\.removeListener\("updated",factoryLinuxApplyWindowControlsTheme\)\)\};/);
  const overlayCount = overlays.length;
  const runtimeCount = (all.match(/const factoryLinuxApplyWindowControlsTheme=/g) || []).length;
  const legacyOverlayCount = (all.match(/titleBarOverlay:process\.platform==="linux"\?\{color:"#171717",symbolColor:"#f5f5f5",height:30\}:void 0/g) || []).length;
  const iconCount = (all.match(/icon:process\.platform==="linux"\?process\.resourcesPath\+"\/factory-desktop\.png":void 0/g) || []).length;
  const unpatchedCount = (all.match(/titleBarStyle:([A-Za-z_$][\w$]*)\?"default":"hidden",trafficLightPosition:\1\?void 0:\{x:12,y:10\},/g) || []).length;
  const validationPassed = markerCount === 1
    && syncMarkerCount === 1
    && syncEndMarkerCount === 1
    && overlayCount === 1
    && runtimeCount === 1
    && runtime !== null
    && overlays[0][1] === runtime[2]
    && legacyOverlayCount === 0
    && iconCount === 1
    && unpatchedCount === 0;
  return {
    validationPassed,
    evidence: { markerCount, syncMarkerCount, syncEndMarkerCount, overlayCount, runtimeCount, aliasesMatch: runtime !== null && overlays[0]?.[1] === runtime[2], legacyOverlayCount, iconCount, unpatchedCount },
    errors: validationPassed ? [] : ["Linux BrowserWindow controls or packaged icon contract was not validated."],
  };
}

function validatePackagedDaemonMode(files) {
  let debugCalls = 0;
  let unguardedDebug = 0;
  let packagedDroidBranch = false;
  let resolverName = null;
  for (const file of files) {
    if (!file.content.includes("--enable-child-ipc")) continue;
    const builderAt = file.content.indexOf("--enable-child-ipc");
    const builder = file.content.slice(Math.max(0, builderAt - 2200), builderAt + 900);
    const branch = builder.match(/if\(([\w$]+)\.app\.isPackaged\)([\w$]+)=[\s\S]{0,1500}?else \2=([\w$]+)\(\);/);
    if (branch) {
      resolverName = branch[3];
      const escaped = resolverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const resolver = file.content.match(new RegExp(`function ${escaped}\\(\\)\\{[\\s\\S]{0,700}?\\}`));
      packagedDroidBranch = Boolean(resolver && resolver[0].includes('return"droid-dev"'));
    }
    const calls = [...builder.matchAll(/([\w$]+)\.push\("--debug"\)/g)];
    debugCalls += calls.length;
    unguardedDebug += calls.filter((call) => !/\.app\.isPackaged\|\|$/.test(builder.slice(Math.max(0, call.index - 100), call.index))).length;
  }
  const validationPassed = debugCalls > 0 && unguardedDebug === 0 && packagedDroidBranch;
  return {
    validationPassed,
    evidence: { debugCalls, unguardedDebug, packagedDroidBranch, resolverName },
    errors: validationPassed ? [] : ["Could not prove packaged mode excludes droid-dev and daemon --debug arguments."],
  };
}

function validatePackaging(root) {
  const fs = require("node:fs");
  const path = require("node:path");
  const requiredFiles = ["launcher/start.sh.template", "packaging/linux/factory-desktop.desktop", "packaging/appimage/AppRun.template"];
  const loaded = Object.fromEntries(requiredFiles.map((file) => {
    const fullPath = path.join(root, file);
    return [file, fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : ""];
  }));
  const missingFiles = requiredFiles.filter((file) => loaded[file] === "");
  const keyring = missingFiles.length === 0 && requiredFiles.every((file) => loaded[file].includes("FACTORY_DISABLE_KEYRING") && /(?:1|:-1)/.test(loaded[file]));
  const desktop = loaded["packaging/linux/factory-desktop.desktop"];
  const productionScheme = desktop.includes("MimeType=x-scheme-handler/factory-desktop;") && !desktop.includes("x-scheme-handler/factory-desktop-dev");
  const productLauncher = desktop.includes("/opt/Factory/factory-desktop-launcher");
  const startupWmClass = desktop.match(/^StartupWMClass=([^\n]+)$/m)?.[1] || null;
  const gnomeWmClass = desktop.match(/^X-GNOME-WMClass=([^\n]+)$/m)?.[1] || null;
  const desktopHints = desktop.includes("BAMF_DESKTOP_FILE_HINT=/usr/share/applications/factory-desktop.desktop")
    && desktop.includes("CHROME_DESKTOP=factory-desktop.desktop");
  const protocol = productionScheme && productLauncher && startupWmClass === "factory" && gnomeWmClass === "factory" && desktopHints;
  return {
    keyring: { validationPassed: keyring, evidence: { keyring, missingFiles }, errors: keyring ? [] : ["Launcher, desktop entry, and AppRun must force FACTORY_DISABLE_KEYRING=1."] },
    protocol: { validationPassed: protocol, evidence: { protocol, productionScheme, productLauncher, startupWmClass, gnomeWmClass, desktopHints }, errors: protocol ? [] : ["Desktop integration is missing the production factory-desktop protocol, exact WM class, or launch identity hints."] },
  };
}

module.exports = { validateTransport, validateListenIpc, validateAdoption, validateSystemDroid, validateAutoUpdater, validateNativeUpdater, validateWindowControls, validatePackagedDaemonMode, validatePackaging };

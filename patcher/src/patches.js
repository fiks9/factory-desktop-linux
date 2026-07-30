"use strict";

const MARKER = (id) => `/* factory-linux:${id} */`;

function result(id, matched, patched, alreadyPatched, changes, evidence = {}) {
  return { id, matched, patched, alreadyPatched, changes, evidence, errors: [] };
}

function mainFile(files, predicate) {
  return files.find((file) => predicate(file.content));
}

function windowControls(files) {
  const id = "linux-window-controls";
  const marker = MARKER(id);
  const currentPattern = /titleBarStyle:([A-Za-z_$][\w$]*)\?"default":"hidden",trafficLightPosition:\1\?void 0:\{x:12,y:10\},/g;
  const currentMatches = [];
  let markerCount = 0;
  let overlayCount = 0;
  let iconCount = 0;
  for (const file of files) {
    markerCount += (file.content.match(/\/\* factory-linux:linux-window-controls \*\//g) || []).length;
    overlayCount += (file.content.match(/titleBarOverlay:process\.platform==="linux"\?\{color:"#171717",symbolColor:"#f5f5f5",height:30\}:void 0/g) || []).length;
    iconCount += (file.content.match(/icon:process\.platform==="linux"\?process\.resourcesPath\+"\/factory-desktop\.png":void 0/g) || []).length;
    for (const match of file.content.matchAll(currentPattern)) {
      currentMatches.push({ file, text: match[0], alias: match[1] });
    }
  }
  const alreadyPatched = markerCount === 1
    && overlayCount === 1
    && iconCount === 1
    && currentMatches.length === 0;
  if (alreadyPatched) {
    const file = files.find((candidate) => candidate.content.includes(marker));
    return result(id, true, false, true, [], {
      file: file?.path,
      markerCount,
      overlayCount,
      iconCount,
      matcher: "browser-window-titlebar-traffic-light-contract",
    });
  }
  if (markerCount !== 0 || overlayCount !== 0 || iconCount !== 0 || currentMatches.length !== 1) {
    return result(id, false, false, false, [], {
      markerCount,
      overlayCount,
      iconCount,
      matchCount: currentMatches.length,
      matcher: "browser-window-titlebar-traffic-light-contract",
    });
  }
  const [{ file, text, alias }] = currentMatches;
  const replacement = `titleBarStyle:${alias}?"default":"hidden",${marker}titleBarOverlay:process.platform==="linux"?{color:"#171717",symbolColor:"#f5f5f5",height:30}:void 0,icon:process.platform==="linux"?process.resourcesPath+"/factory-desktop.png":void 0,trafficLightPosition:${alias}?void 0:{x:12,y:10},`;
  return result(id, true, true, false, [[file.path, file.content.replace(text, replacement)]], {
    file: file.path,
    matchCount: 1,
    matcher: "browser-window-titlebar-traffic-light-contract",
  });
}

function daemonTransport(files) {
  const marker = MARKER("daemon-transport-force-websocket");
  const existing = mainFile(files, (content) => content.includes(marker));
  if (existing) return result("daemon-transport-force-websocket", true, false, true, [], { file: existing.path });
  for (const file of files) {
    const anchor = file.content.indexOf("DesktopDaemonIpc");
    if (anchor < 0) continue;
    const windowStart = Math.max(0, file.content.lastIndexOf("async function ", anchor));
    const windowEnd = Math.min(file.content.length, anchor + 3000);
    const window = file.content.slice(windowStart, windowEnd);
    const ternary = window.match(/([\w$]+)\.Ipc:([\w$]+)\.WebSocket/);
    if (!ternary || ternary[1] !== ternary[2]) continue;
    const enumRef = ternary[1];
    const returnStart = window.lastIndexOf("return", ternary.index);
    if (returnStart < 0 || window.slice(returnStart, ternary.index).includes(";")) continue;
    const absoluteStart = windowStart + returnStart;
    const ternaryEnd = windowStart + ternary.index + ternary[0].length;
    const content = `${file.content.slice(0, windowStart)}${marker}${file.content.slice(windowStart, absoluteStart)}return ${enumRef}.WebSocket${file.content.slice(ternaryEnd)}`;
    return result("daemon-transport-force-websocket", true, true, false, [[file.path, content]], { matcher: "statsigResolverMatcher", file: file.path, enumRef });
  }
  for (const file of files) {
    const match = file.content.match(/function\s+([\w$]+)\(\)\{return\s+([\w$]+)\.Ipc\}/);
    if (match) {
      const [, fn, enumRef] = match;
      const use = new RegExp(`resolveTransportMode\\(\\)[\\s\\S]{0,300}${fn}\\(|${fn}\\(\\)[\\s\\S]{0,300}transportMode`).test(file.content);
      if (!use) continue;
      const original = match[0];
      return result("daemon-transport-force-websocket", true, true, false, [[file.path, file.content.replace(original, `${marker}function ${fn}(){return ${enumRef}.WebSocket}`)]], { matcher: "hardcodedIpcResolverMatcher", file: file.path, resolver: fn, enumRef, backtrace: "resolveTransportMode" });
    }
  }
  return result("daemon-transport-force-websocket", false, false, false, [], { matchers: ["statsigResolverMatcher", "hardcodedIpcResolverMatcher", "callsiteBacktraceMatcher"] });
}

function preventListen(files) {
  const marker = MARKER("prevent-listen-ipc");
  const file = mainFile(files, (content) => content.includes('push("--listen","ipc")'));
  if (!file) return result("prevent-listen-ipc", false, false, false, []);
  if (file.content.includes(marker)) return result("prevent-listen-ipc", true, false, true, [], { file: file.path });
  const pattern = /([\w$]+)\.push\("--listen","ipc"\)/;
  const match = file.content.match(pattern);
  if (!match) return result("prevent-listen-ipc", false, false, false, []);
  const replacement = `process.platform!=="linux"&&${match[0]}`;
  return result("prevent-listen-ipc", true, true, false, [[file.path, file.content.replace(match[0], `${marker}${replacement}`)]], { file: file.path, matcher: "daemon-spawn-args" });
}

function systemDroid(files) {
  const id = "system-droid-cli-resolver"; const marker = MARKER(id);
  const existing = mainFile(files, (content) => content.includes(marker));
  if (existing) return result(id, true, false, true, [], { file: existing.path });
  const file = mainFile(files, (content) => content.includes('process.resourcesPath,"bin"') && content.includes('"droid"'));
  if (!file) return result(id, false, false, false, []);
  const pattern = /([\w$]+)\.join\(process\.resourcesPath,"bin",process\.platform==="win32"\?"droid\.exe":"droid"\)/;
  const match = file.content.match(pattern);
  if (!match) return result(id, false, false, false, [], { expected: "packaged droid resolver" });
  const replacement = `(()=>{${marker}const fs=require("fs"),path=require("path"),cp=require("child_process"),os=require("os");const usable=p=>{try{fs.accessSync(p,fs.constants.X_OK);return fs.statSync(p).isFile()}catch(e){return false}};const candidates=[];if(process.env.FACTORY_DROID_PATH)candidates.push(process.env.FACTORY_DROID_PATH);try{const p=cp.execFileSync("sh",["-lc","command -v droid"],{encoding:"utf8",timeout:2000}).trim();if(p)candidates.push(p)}catch(e){}candidates.push(path.join(os.homedir(),".local","bin","droid"),"/usr/local/bin/droid","/usr/bin/droid");for(const p of candidates)if(usable(p)){console.info("[factory-linux] droid CLI",p);return p}throw new Error("Droid CLI not found. Install droid or set FACTORY_DROID_PATH")})()`;
  return result(id, true, true, false, [[file.path, file.content.replace(match[0], replacement)]], { file: file.path, lookup: ["FACTORY_DROID_PATH", "command -v droid", "~/.local/bin/droid", "/usr/local/bin/droid", "/usr/bin/droid"] });
}

function adoption(files) {
  const id = "system-daemon-adoption"; const marker = MARKER(id);
  const file = mainFile(files, (content) => content.includes("--enable-child-ipc") && content.includes("currentPort") && content.includes("async startInternal"));
  if (!file) return result(id, false, false, false, []);
  if (file.content.includes(marker)) return result(id, true, false, true, [], { file: file.path, marker });
  const startPath = file.content.match(/async startInternal\(\)\{this\.state=([\w$]+)\.Starting[\s\S]{0,600}?this\.currentPort=([\w$]+);[\s\S]{0,600}?let ([\w$]+);if\(\2!==null\)/);
  if (!startPath) return result(id, false, false, false, [], { expected: "currentPort=<port> ... let <scratch>; if(<port>!==null)" });
  const stateEnum = startPath[1];
  const portVar = startPath[2];
  const scratchVar = startPath[3];
  const anchor = `let ${scratchVar};if(${portVar}!==null)`;
  const code = `${marker}const FACTORY_DAEMON_ADOPTION_TIMEOUT_MS=15000;const factoryLinuxAdoptDaemon=async()=>{if(process.platform!=="linux")return false;const deadline=Date.now()+FACTORY_DAEMON_ADOPTION_TIMEOUT_MS;const healthy=async()=>{try{const response=await fetch("http://127.0.0.1:37643/health",{signal:AbortSignal.timeout(2000)});if(!response.ok)return false;const body=(await response.text()).trim();return body==="ok"||body.startsWith("factory-daemon ok")}catch(e){return false}};if(await healthy())return true;try{require("child_process").execFileSync("systemctl",["--user","restart","factory-droid-daemon.service"],{stdio:"ignore",timeout:10000})}catch(e){}while(Date.now()<deadline){if(await healthy())return true;await new Promise(resolve=>setTimeout(resolve,400))}return false};if(await factoryLinuxAdoptDaemon()){this.currentPort=37643;this.state=${stateEnum}.Running;this.process=null;this.processGeneration++;this.startHealthPoll();return} `;
  return result(id, true, true, false, [[file.path, file.content.replace(anchor, `${code}${anchor}`)]], { file: file.path, anchor: "dynamic-daemon-start-path", stateEnum, portVar, scratchVar, health: "http://127.0.0.1:37643/health", timeoutMs: 15000, fallback: "systemctl --user restart factory-droid-daemon.service" });
}

function autoUpdater(files) {
  const id = "auto-updater-guard"; const marker = MARKER(id); const changes=[]; let matched=false;
  for (const file of files) {
    let content=file.content;
    if (content.includes(marker)) return result(id, true, false, true, [], { file: file.path });
    if (!/[\w$]+\.autoUpdater\.(?:checkForUpdates|quitAndInstall)\(\)/.test(content)) continue;
    matched=true;
    content=content.replace(/([\w$]+)\.autoUpdater\.checkForUpdates\(\)/g, (_call, electronAlias) => `${marker}process.platform!=="linux"&&${electronAlias}.autoUpdater.checkForUpdates()`);
    content=content.replace(/([\w$]+)\.autoUpdater\.quitAndInstall\(\)/g, (_call, electronAlias) => `process.platform!=="linux"&&${electronAlias}.autoUpdater.quitAndInstall()`);
    changes.push([file.path,content]);
  }
  return result(id, matched, changes.length>0, changes.length===0&&matched, changes, { calls: changes.length });
}

function matchingParen(content, opening) {
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let depth = 0;
  for (let index = opening; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function ipcHandlers(files, channel) {
  const matches = [];
  const pattern = new RegExp(`([\\w$]+)\\.ipcMain\\.handle\\((["'])updates:${channel}\\2\\s*,`, "g");
  for (const file of files) {
    for (const match of file.content.matchAll(pattern)) {
      const opening = match.index + match[0].indexOf("(");
      const end = matchingParen(file.content, opening);
      matches.push({ file, alias: match[1], start: match.index, end: end < 0 ? end : end + 1 });
    }
  }
  return matches;
}

function contiguousHandlerSpan(handlers, content) {
  const ordered = [...handlers].sort((left, right) => left.start - right.start);
  const separators = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const gap = content.slice(ordered[index - 1].end, ordered[index].start);
    if (!/^[,;\s]*$/.test(gap)) return null;
    separators.push(gap);
  }
  return {
    start: ordered[0].start,
    end: ordered[ordered.length - 1].end,
    ordered,
    separators,
  };
}

function nativeUpdater(files) {
  const id = "linux-native-updater-button";
  const marker = MARKER(id);
  const existing = files.find((file) => file.content.includes(marker));
  if (existing) return result(id, true, false, true, [], { file: existing.path });
  const channels = [
    ["getState", "getState"],
    ["install", "install"],
    ["checkNow", "checkNow"],
  ];
  const found = channels.map(([channel, action]) => ({ channel, action, matches: ipcHandlers(files, channel) }));
  if (found.some((entry) => entry.matches.length !== 1 || entry.matches[0].end < 0)) {
    return result(id, false, false, false, [], {
      handlerCounts: Object.fromEntries(found.map((entry) => [entry.channel, entry.matches.length])),
    });
  }
  const target = found[0].matches[0].file;
  const alias = found[0].matches[0].alias;
  if (found.some((entry) => entry.matches[0].file !== target || entry.matches[0].alias !== alias)) {
    return result(id, false, false, false, [], { error: "update IPC handlers do not share one Electron contract" });
  }
  const bridgeName = "factoryLinuxUpdateBridge";
  const handlers = found
    .map((entry) => ({ ...entry.matches[0], action: entry.action }))
    .sort((left, right) => left.start - right.start);
  const span = contiguousHandlerSpan(handlers, target.content);
  if (!span) {
    return result(id, false, false, false, [], {
      matcher: "contiguous-ipc-handler-span",
      error: "update IPC handlers are not one separator-only span",
    });
  }
  const appImageFallback = `{dispatch:async()=>{const state={schemaVersion:1,kind:"error",linuxState:"update-manager-unavailable",message:"Native updates are unavailable in AppImage"};for(const window of ${alias}.BrowserWindow.getAllWindows())window.isDestroyed()||window.webContents.send("updates:state",state);return state}}`;
  const replacement = `${marker}(()=>{const ${bridgeName}=process.env.FACTORY_UPDATE_MANAGER_UNAVAILABLE==="1"?${appImageFallback}:require("/usr/lib/factory-desktop/update-bridge.cjs").createBridge({electron:${alias}});${span.ordered.map((handler) => `${alias}.ipcMain.handle("updates:${handler.action}",()=>${bridgeName}.dispatch("${handler.action}",{}))`).join(";")}})()`;
  const content = `${target.content.slice(0, span.start)}${replacement}${target.content.slice(span.end)}`;
  return result(id, true, true, false, [[target.path, content]], {
    file: target.path,
    bridge: "/usr/lib/factory-desktop/update-bridge.cjs",
    handlers: channels.map(([channel]) => channel),
    handlerCount: span.ordered.length,
    matcher: "contiguous-ipc-handler-span",
    insertionContext: "expression-iife",
    separators: span.separators,
  });
}

module.exports = { daemonTransport, preventListen, systemDroid, adoption, autoUpdater, nativeUpdater, windowControls };

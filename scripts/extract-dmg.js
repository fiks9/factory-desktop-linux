"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { sha256File } = require("./dmg");

function run7z(args) {
  const command = process.env.SEVEN_ZIP || (fs.existsSync("/usr/bin/7zz") ? "/usr/bin/7zz" : "7z");
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60 * 1000 });
}

function listDmg(dmgPath) {
  return run7z(["l", "-slt", dmgPath]);
}

function findEntry(listing, predicate) {
  const entries = listing.split(/\r?\n(?=Path = )/).map((entry) => {
    const match = entry.match(/^Path = (.+)$/m);
    return match && match[1];
  }).filter(Boolean);
  return entries.find(predicate) || null;
}

function findAppAsar(listing) {
  return findEntry(listing, (entry) => /\.app\/Contents\/Resources\/app\.asar$/.test(entry));
}

function findAppAsarUnpacked(listing) {
  return findEntry(listing, (entry) => /\.app\/Contents\/Resources\/app\.asar\.unpacked$/.test(entry));
}

function findAppInfo(listing) {
  return findEntry(listing, (entry) => /\.app\/Contents\/Info\.plist$/.test(entry));
}

function findFrameworkInfo(listing) {
  return findEntry(listing, (entry) => /Electron Framework\.framework\/Versions\/A\/Resources\/Info\.plist$/.test(entry));
}

function findIcon(listing) {
  return findEntry(listing, (entry) => /\.app\/Contents\/Resources\/(?:electron|Factory)\.icns$/i.test(entry));
}

function extractEntry(dmgPath, outputDir, entry, required) {
  if (!entry) {
    if (required) throw new Error("Required DMG entry was not found");
    return null;
  }
  try {
    run7z(["x", "-y", `-o${outputDir}`, dmgPath, entry]);
  } catch (error) {
    const extracted = path.join(outputDir, entry);
    if (!fs.existsSync(extracted) && required) throw new Error(`Failed to extract ${entry}: ${error.message}`);
  }
  const extracted = path.join(outputDir, entry);
  if (!fs.existsSync(extracted) && required) throw new Error(`7z did not materialize required entry: ${entry}`);
  return extracted;
}

function plistValue(content, key) {
  const match = content.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
  return match ? match[1].trim() : null;
}

function validateDmgFile(dmgPath, expectedSha256) {
  const stat = fs.statSync(dmgPath);
  if (!stat.isFile() || stat.size === 0) throw new Error(`DMG is empty or not a file: ${dmgPath}`);
  const sha256 = sha256File(dmgPath);
  if (expectedSha256 && sha256 !== expectedSha256) throw new Error(`DMG SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`);
  const listing = listDmg(dmgPath);
  const appAsarEntry = findAppAsar(listing);
  const appAsarUnpackedEntry = findAppAsarUnpacked(listing);
  const infoEntry = findAppInfo(listing);
  if (!appAsarEntry || !infoEntry) throw new Error("DMG acceptance failed: Factory.app/Contents/app.asar or Info.plist not found");
  return { sha256, bytes: stat.size, listing, appAsarEntry, appAsarUnpackedEntry, infoEntry, frameworkEntry: findFrameworkInfo(listing), iconEntry: findIcon(listing) };
}

function extractDmg(dmgPath, outputDir, options = {}) {
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const profile = validateDmgFile(dmgPath, options.expectedSha256);
  const appAsarPath = extractEntry(dmgPath, outputDir, profile.appAsarEntry, true);
  const appAsarUnpackedPath = extractEntry(dmgPath, outputDir, profile.appAsarUnpackedEntry, false);
  const infoPlistPath = extractEntry(dmgPath, outputDir, profile.infoEntry, true);
  const frameworkPlistPath = extractEntry(dmgPath, outputDir, profile.frameworkEntry, false);
  const iconPath = extractEntry(dmgPath, outputDir, profile.iconEntry, false);
  const info = fs.readFileSync(infoPlistPath, "utf8");
  const version = plistValue(info, "CFBundleShortVersionString") || plistValue(info, "CFBundleVersion");
  if (!version) throw new Error("DMG acceptance failed: Factory version missing from Info.plist");
  if (options.expectedVersion && version !== options.expectedVersion) throw new Error(`Factory version mismatch: expected ${options.expectedVersion}, got ${version}`);
  let electronVersion = null;
  if (frameworkPlistPath && fs.existsSync(frameworkPlistPath)) electronVersion = plistValue(fs.readFileSync(frameworkPlistPath, "utf8"), "CFBundleShortVersionString") || plistValue(fs.readFileSync(frameworkPlistPath, "utf8"), "CFBundleVersion");
  if (!electronVersion) throw new Error("DMG acceptance failed: Electron Framework version missing");
  return {
    dmgPath,
    dmgSha256: profile.sha256,
    bytes: profile.bytes,
    version,
    electronVersion,
    appAsarPath,
    appAsarUnpackedPath,
    infoPlistPath,
    frameworkPlistPath,
    iconPath,
    appAsarSha256: sha256File(appAsarPath),
  };
}

if (require.main === module) {
  const [dmgPath, outputDir, expectedVersion] = process.argv.slice(2);
  if (!dmgPath || !outputDir) {
    console.error("Usage: node scripts/extract-dmg.js /absolute/Factory.dmg /absolute/output [version]");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(extractDmg(dmgPath, outputDir, { expectedVersion }), null, 2));
  } catch (error) {
    console.error(`DMG extraction failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { listDmg, findAppAsar, findAppAsarUnpacked, validateDmgFile, extractDmg, plistValue };

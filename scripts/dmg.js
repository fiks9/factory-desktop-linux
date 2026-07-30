"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");

const LATEST_VERSION_URL = "https://api.factory.ai/api/desktop/latest-version";
const DESKTOP_DOWNLOAD_URL = "https://app.factory.ai/api/desktop";
const OFFICIAL_DMG_ORIGIN = "https://s3.us-west-1.amazonaws.com";
const OFFICIAL_DMG_PREFIX = "/downloads.factory.ai/factory-desktop/releases";
const DEFAULT_ARCH = "x64";

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let read;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(dirPath) {
  try {
    const fd = fs.openSync(dirPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error.code !== "EINVAL" && error.code !== "EISDIR") throw error;
  }
}

function parseVersion(value) {
  const version = String(value || "").match(/^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  if (!version) throw new Error(`Invalid Factory version: ${value}`);
  return version[1];
}

function buildDownloadUrl(arch = DEFAULT_ARCH) {
  if (!/[A-Za-z0-9_-]+/.test(arch)) throw new Error(`Invalid architecture: ${arch}`);
  return `${DESKTOP_DOWNLOAD_URL}?platform=darwin&architecture=${encodeURIComponent(arch)}`;
}

function parseOfficialArchitecture(value = DEFAULT_ARCH) {
  if (value !== DEFAULT_ARCH) throw new Error(`Unsupported official Factory DMG architecture: ${value}`);
  return value;
}

function exactDownloadPath(version, arch = DEFAULT_ARCH) {
  version = parseVersion(version);
  arch = parseOfficialArchitecture(arch);
  return `${OFFICIAL_DMG_PREFIX}/${version}/darwin/${arch}/Factory-${version}-${arch}.dmg`;
}

function buildExactDownloadUrl(version, arch = DEFAULT_ARCH) {
  return `${OFFICIAL_DMG_ORIGIN}${exactDownloadPath(version, arch)}`;
}

function validateOfficialDmgUrl(value, version, arch = DEFAULT_ARCH) {
  const expectedPath = exactDownloadPath(version, arch);
  let candidate;
  try {
    candidate = new URL(value);
  } catch {
    throw new Error("Official Factory DMG URL is invalid");
  }
  if (candidate.protocol !== "https:" || candidate.origin !== OFFICIAL_DMG_ORIGIN) {
    throw new Error("Official Factory DMG URL must use the expected HTTPS host");
  }
  if (candidate.pathname !== expectedPath) {
    throw new Error(`Official Factory DMG URL path does not match requested version ${parseVersion(version)}`);
  }
  if (candidate.username || candidate.password || candidate.port || candidate.search || candidate.hash) {
    throw new Error("Official Factory DMG URL must not contain credentials, port, query, or fragment");
  }
  return `${OFFICIAL_DMG_ORIGIN}${expectedPath}`;
}

function resolveOfficialDmgRedirect(currentUrl, location, version, arch = DEFAULT_ARCH) {
  const current = validateOfficialDmgUrl(currentUrl, version, arch);
  if (typeof location !== "string" || !location) throw new Error("Official Factory DMG redirect is missing");
  return validateOfficialDmgUrl(new URL(location, current).toString(), version, arch);
}

function parseVersionFromUrl(url) {
  const match = String(url).match(/\/releases\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\//);
  return match ? match[1] : null;
}

function request(url, timeoutMs = 30000, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error("Too many redirects"));
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https:") ? https : http;
    const requestHandle = transport.get(url, { timeout: timeoutMs }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        request(next, timeoutMs, redirects + 1).then(resolve, reject);
        return;
      }
      resolve({ response, finalUrl: url });
    });
    requestHandle.on("timeout", () => requestHandle.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    requestHandle.on("error", reject);
  });
}

async function discoverLatestVersion(options = {}) {
  const endpoint = options.endpoint || LATEST_VERSION_URL;
  const { response } = await request(endpoint, options.timeoutMs || 30000);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.resume();
    throw new Error(`Factory version endpoint returned HTTP ${response.statusCode}`);
  }
  const body = await readResponse(response);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Factory version endpoint did not return JSON");
  }
  return parseVersion(parsed.latestVersion || parsed.version);
}

function readResponse(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.on("error", reject);
  });
}

function streamToContentAddressed(url, cacheDir, options = {}) {
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  const validateUrl = options.validateUrl || ((value) => value);
  const resolveRedirect = options.resolveRedirect || ((currentUrl, location) => new URL(location, currentUrl).toString());
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const partial = path.join(cacheDir, `.Factory-${process.pid}-${Date.now()}.partial`);

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { fs.rmSync(partial, { force: true }); } catch {}
      reject(error);
    };

    const fetch = (candidateUrl, redirects = 0) => {
      if (redirects > 8) return fail(new Error("Too many DMG redirects"));
      let currentUrl;
      try {
        currentUrl = validateUrl(candidateUrl);
      } catch (error) {
        return fail(error);
      }
      const transport = currentUrl.startsWith("https:") ? https : http;
      const requestHandle = transport.get(currentUrl, { timeout: timeoutMs }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          let next;
          try {
            next = resolveRedirect(currentUrl, response.headers.location);
          } catch (error) {
            return fail(error);
          }
          fetch(next, redirects + 1);
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          return fail(new Error(`DMG endpoint returned HTTP ${response.statusCode}`));
        }
        const output = fs.createWriteStream(partial, { mode: 0o600 });
        response.on("data", (chunk) => {
          bytes += chunk.length;
          hash.update(chunk);
        });
        response.on("error", fail);
        output.on("error", fail);
        output.on("finish", () => {
          try {
            output.close(() => {
              const digest = hash.digest("hex");
              const finalPath = path.join(cacheDir, `Factory-${digest}.dmg`);
              fsyncFile(partial);
              if (fs.existsSync(finalPath)) {
                const existing = sha256File(finalPath);
                if (existing !== digest) throw new Error(`Cache collision at ${finalPath}`);
                fs.rmSync(partial, { force: true });
              } else {
                fs.renameSync(partial, finalPath);
                fsyncDirectory(cacheDir);
              }
              settled = true;
              resolve({ path: finalPath, sha256: digest, bytes, finalUrl: currentUrl });
            });
          } catch (error) {
            fail(error);
          }
        });
        response.pipe(output);
      });
      requestHandle.on("timeout", () => requestHandle.destroy(new Error(`DMG download timed out after ${timeoutMs}ms`)));
      requestHandle.on("error", fail);
    };
    fetch(url);
  });
}

async function acquireExactDmg(options = {}) {
  const version = parseVersion(options.version);
  const arch = parseOfficialArchitecture(options.arch || DEFAULT_ARCH);
  const cacheDir = options.cacheDir || path.join(process.cwd(), "downloads");
  const requestedUrl = buildExactDownloadUrl(version, arch);
  const validateUrl = (value) => validateOfficialDmgUrl(value, version, arch);
  const resolveRedirect = (currentUrl, location) => resolveOfficialDmgRedirect(currentUrl, location, version, arch);
  const download = options.download || streamToContentAddressed;
  const downloadOptions = { ...options, resolveRedirect, validateUrl };
  delete downloadOptions.download;
  const result = await download(requestedUrl, cacheDir, downloadOptions);
  const finalUrl = validateUrl(result.finalUrl);
  const finalVersion = parseVersionFromUrl(finalUrl);
  if (finalVersion !== version) {
    throw new Error(`Factory version changed during exact download: requested ${version}, received ${finalVersion || "unknown"}`);
  }
  return { ...result, finalUrl, version, source: "official" };
}

function cachePinnedDmg(dmgPath, cacheDir) {
  if (!path.isAbsolute(dmgPath)) throw new Error("Pinned DMG path must be absolute");
  const stat = fs.statSync(dmgPath);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Pinned DMG is not a non-empty file: ${dmgPath}`);
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const digest = sha256File(dmgPath);
  const finalPath = path.join(cacheDir, `Factory-${digest}.dmg`);
  if (!fs.existsSync(finalPath)) {
    const partial = `${finalPath}.partial-${process.pid}`;
    fs.copyFileSync(dmgPath, partial);
    fsyncFile(partial);
    fs.renameSync(partial, finalPath);
    fsyncDirectory(cacheDir);
  } else if (sha256File(finalPath) !== digest) {
    throw new Error(`Cache collision at ${finalPath}`);
  }
  return { path: finalPath, sha256: digest, bytes: stat.size, version: null, source: "pinned" };
}

async function acquireDmg(options = {}) {
  const cacheDir = options.cacheDir || path.join(process.cwd(), "downloads");
  if (options.pinnedPath) return cachePinnedDmg(options.pinnedPath, cacheDir);
  const version = options.version ? parseVersion(options.version) : await discoverLatestVersion(options);
  return acquireExactDmg({ ...options, version, cacheDir });
}

module.exports = {
  LATEST_VERSION_URL,
  DESKTOP_DOWNLOAD_URL,
  OFFICIAL_DMG_ORIGIN,
  OFFICIAL_DMG_PREFIX,
  buildDownloadUrl,
  buildExactDownloadUrl,
  parseVersion,
  parseVersionFromUrl,
  discoverLatestVersion,
  resolveOfficialDmgRedirect,
  sha256File,
  streamToContentAddressed,
  cachePinnedDmg,
  validateOfficialDmgUrl,
  acquireExactDmg,
  acquireDmg,
};

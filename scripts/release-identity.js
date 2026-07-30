"use strict";

const { parseVersion } = require("./dmg");

function parseWrapperRevision(value) {
  if (typeof value !== "string") throw new Error("Invalid wrapper revision");
  const match = value.match(/^linux\.([1-9][0-9]*)$/);
  if (!match) throw new Error(`Invalid wrapper revision: ${value}`);
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid wrapper revision: ${value}`);
  return { value, number };
}

function releaseIdentity(factoryVersion, wrapperRevision = null) {
  factoryVersion = parseVersion(factoryVersion);
  if (/-linux\.[0-9]+(?:$|[.+-])/.test(factoryVersion)) {
    throw new Error("Factory version must not contain the Linux wrapper revision");
  }
  if (wrapperRevision === null || wrapperRevision === undefined) {
    return {
      factoryVersion,
      wrapperRevision: null,
      tag: `v${factoryVersion}`,
      debVersion: factoryVersion,
      rpmVersion: factoryVersion,
      rpmRelease: "1",
      appImageVersion: factoryVersion,
      appImageFilename: `Factory-${factoryVersion}-x86_64.AppImage`,
      debFilename: `factory-desktop_${factoryVersion}_amd64.deb`,
      rpmFilename: `factory-desktop-${factoryVersion}-1.x86_64.rpm`,
    };
  }
  const parsed = parseWrapperRevision(wrapperRevision);
  const rpmRelease = String(parsed.number + 1);
  if (!Number.isSafeInteger(parsed.number + 1)) throw new Error(`Invalid wrapper revision: ${wrapperRevision}`);
  return {
    factoryVersion,
    wrapperRevision: parsed.value,
    tag: `v${factoryVersion}-${parsed.value}`,
    debVersion: `${factoryVersion}-${parsed.number}`,
    rpmVersion: factoryVersion,
    rpmRelease,
    appImageVersion: `${factoryVersion}-${parsed.value}`,
    appImageFilename: `Factory-${factoryVersion}-${parsed.value}-x86_64.AppImage`,
    debFilename: `factory-desktop_${factoryVersion}-${parsed.number}_amd64.deb`,
    rpmFilename: `factory-desktop-${factoryVersion}-${rpmRelease}.x86_64.rpm`,
  };
}

module.exports = { parseWrapperRevision, releaseIdentity };

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { assertPackagedRuntimeLayout, sha256 } = require("./runtime");
const { assertAcceptedPatchReport, assertNoBundledDroid, resolveUpdaterBinary } = require("./package-deb");
const { scanPackageTree, stageInstalledUpdateBuilder } = require("./package-hygiene");
const { RPM_POST_INSTALL, RPM_PRE_UNINSTALL } = require("./package-contract");
const { writePackageBuildInfo } = require("./release-metadata");
const { validateAppJavaScript } = require("./validate-app-javascript");
const { releaseIdentity } = require("./release-identity");

function rpmVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`RPM prerelease/build versions are unsupported: ${version}`);
  return version;
}

function requireTool(tool) {
  try { return execFileSync("sh", ["-lc", `command -v ${tool}`], { encoding: "utf8" }).trim(); }
  catch { throw new Error(`${tool} is required to build RPM packages`); }
}

function buildRpm(options) {
  requireTool("rpmbuild"); requireTool("tar");
  const appDir = path.resolve(options.appDir), identity = releaseIdentity(options.version, options.wrapperRevision ?? null), version = identity.factoryVersion;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid RPM version: ${version}`);
  assertPackagedRuntimeLayout(appDir); assertNoBundledDroid(appDir); assertAcceptedPatchReport(appDir); validateAppJavaScript(appDir);
  scanPackageTree(appDir, { workspaceRoot: process.cwd() });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-rpm-"));
  try {
  const top = path.join(root, "rpmbuild"), payload = path.join(root, "payload");
  for (const dir of ["BUILD", "BUILDROOT", "RPMS", "SOURCES", "SPECS", "SRPMS"]) fs.mkdirSync(path.join(top, dir), { recursive: true });
  fs.mkdirSync(path.join(payload, "opt", "Factory"), { recursive: true });
  fs.cpSync(appDir, path.join(payload, "opt", "Factory"), { recursive: true, dereference: false });
  writePackageBuildInfo(path.join(payload, "opt", "Factory"), "rpm", { wrapperRevision: identity.wrapperRevision });
  fs.mkdirSync(path.join(payload, "usr", "bin"), { recursive: true });
  fs.copyFileSync(resolveUpdaterBinary(options), path.join(payload, "usr", "bin", "factory-update-manager"));
  fs.chmodSync(path.join(payload, "usr", "bin", "factory-update-manager"), 0o755);
  stageInstalledUpdateBuilder(path.resolve(__dirname, ".."), path.join(payload, "usr", "lib", "factory-desktop", "update-builder"));
  const copies = [
    ["packaging/linux/factory-desktop.desktop", "usr/share/applications/factory-desktop.desktop", 0o644],
    ["packaging/linux/factory-droid-daemon.sh", "usr/lib/factory-desktop/factory-droid-daemon", 0o755],
    ["packaging/linux/factory-droid-daemon.service", "usr/lib/systemd/user/factory-droid-daemon.service", 0o644],
    ["packaging/linux/factory-update-manager.service", "usr/lib/systemd/user/factory-update-manager.service", 0o644],
    ["packaging/linux/update-bridge.cjs", "usr/lib/factory-desktop/update-bridge.cjs", 0o644],
    ["packaging/linux/org.factory.desktop.update-manager.policy", "usr/share/polkit-1/actions/org.factory.desktop.update-manager.policy", 0o644],
    ["assets/factory-desktop.svg", "usr/share/icons/hicolor/scalable/apps/factory-desktop.svg", 0o644],
  ];
  for (const [source, target, mode] of copies) { const output=path.join(payload,target);fs.mkdirSync(path.dirname(output),{recursive:true});fs.copyFileSync(path.resolve(source),output);fs.chmodSync(output,mode); }
  const iconSource = path.join(appDir, "resources", "factory-desktop.png");
  if (!fs.statSync(iconSource, { throwIfNoEntry: false })?.isFile()) throw new Error(`Staged app is missing required factory-desktop.png icon: ${iconSource}`);
  fs.mkdirSync(path.join(payload, "usr", "share", "icons", "hicolor", "512x512", "apps"), { recursive: true });
  fs.copyFileSync(iconSource, path.join(payload, "usr", "share", "icons", "hicolor", "512x512", "apps", "factory-desktop.png"));
  fs.chmodSync(path.join(payload, "usr", "share", "icons", "hicolor", "512x512", "apps", "factory-desktop.png"), 0o644);
  scanPackageTree(payload, { workspaceRoot: process.cwd() });
  execFileSync("tar", ["-C", payload, "-czf", path.join(top, "SOURCES", "factory-payload.tar.gz"), "."], { stdio: "ignore" });
  const spec = `Name: factory-desktop\nVersion: ${rpmVersion(identity.rpmVersion)}\nRelease: ${identity.rpmRelease}\nSummary: Unofficial Factory Desktop Linux wrapper\nLicense: MIT\nBuildArch: x86_64\nSource0: factory-payload.tar.gz\nRequires: gtk3, nss, libXScrnSaver, libXtst, nodejs, npm, xdg-utils\n\n%description\nLinux compatibility wrapper built from an authorized Factory Desktop DMG.\n\n%prep\n%setup -q -c -T\ntar -xzf %{SOURCE0}\n\n%build\n\n%install\nmkdir -p %{buildroot}\ncp -a . %{buildroot}/\n\n%post\n${RPM_POST_INSTALL}\n\n%preun\n${RPM_PRE_UNINSTALL}\n\n%files\n/opt/Factory\n/usr/share/applications/factory-desktop.desktop\n/usr/lib/factory-desktop/factory-droid-daemon\n/usr/lib/systemd/user/factory-droid-daemon.service\n/usr/share/polkit-1/actions/org.factory.desktop.update-manager.policy\n/usr/share/icons/hicolor/scalable/apps/factory-desktop.svg\n/usr/share/icons/hicolor/512x512/apps/factory-desktop.png\n`;
  const specWithUpdater = spec.replace("/opt/Factory\n", "/opt/Factory\n/usr/bin/factory-update-manager\n").replace("/usr/lib/factory-desktop/factory-droid-daemon\n", "/usr/lib/factory-desktop/factory-droid-daemon\n/usr/lib/factory-desktop/update-bridge.cjs\n/usr/lib/factory-desktop/update-builder\n").replace("/usr/lib/systemd/user/factory-droid-daemon.service\n", "/usr/lib/systemd/user/factory-droid-daemon.service\n/usr/lib/systemd/user/factory-update-manager.service\n");
  const specPath=path.join(top,"SPECS","factory-desktop.spec");fs.writeFileSync(specPath,specWithUpdater);
  execFileSync("rpmbuild", ["-bb", "--define", `_topdir ${top}`, specPath], { stdio: "inherit", timeout: 10*60*1000 });
  const built=path.join(top,"RPMS","x86_64");const rpm=fs.readdirSync(built).find((file)=>file.endsWith(".rpm"));if(!rpm)throw new Error("rpmbuild did not produce an RPM");
  const outputDir=path.resolve(options.outputDir||"dist"),output=path.join(outputDir,identity.rpmFilename);fs.mkdirSync(outputDir,{recursive:true});fs.copyFileSync(path.join(built,rpm),output);
  require("./inspect-package").inspectPackage(output);
  return { path:output,sha256:sha256(output),bytes:fs.statSync(output).size };
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}

if(require.main===module){const [appDir,version,outputDir]=process.argv.slice(2);try{console.log(JSON.stringify(buildRpm({appDir,version,outputDir}),null,2))}catch(error){console.error(`RPM build failed: ${error.message}`);process.exit(1)}}
module.exports={buildRpm,rpmVersion,RPM_POST_INSTALL,RPM_PRE_UNINSTALL};

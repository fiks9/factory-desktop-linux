"use strict";

const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process");
const {scanPackageTree}=require("./package-hygiene");
const {assertAcceptedPatchReport}=require("./package-deb");
const {RPM_POST_INSTALL,RPM_PRE_UNINSTALL}=require("./package-contract");

const DEB_CONTROL_MEMBERS=new Set(["control","postinst","prerm","postrm"]);
const NATIVE_PAYLOAD_FILES=new Set([
  "usr/bin/factory-update-manager",
  "usr/lib/factory-desktop/factory-droid-daemon",
  "usr/lib/systemd/user/factory-droid-daemon.service",
  "usr/lib/systemd/user/factory-update-manager.service",
  "usr/share/applications/factory-desktop.desktop",
  "usr/share/icons/hicolor/512x512/apps/factory-desktop.png",
  "usr/share/icons/hicolor/scalable/apps/factory-desktop.svg",
  "usr/share/polkit-1/actions/org.factory.desktop.update-manager.policy",
]);

function normalizeText(value){return String(value).replace(/\r\n/g,"\n").replace(/\n+$/,"");}
function assertNativePackageMetadata(format,metadata,expectedVersion){const architecture=format==="deb"?"amd64":"x86_64";if(metadata.name!=="factory-desktop")throw new Error(`${format}: unexpected package name: ${metadata.name}`);if(metadata.version!==expectedVersion)throw new Error(`${format}: package version ${metadata.version} does not match staged Factory version ${expectedVersion}`);if(metadata.architecture!==architecture)throw new Error(`${format}: unexpected package architecture: ${metadata.architecture}`);}
function assertAllowedNativePayload(root,format){const walk=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const full=path.join(directory,entry.name),relative=path.relative(root,full).split(path.sep).join("/");if(entry.isDirectory()){walk(full);continue}const allowed=relative.startsWith("opt/Factory/")||relative.startsWith("usr/lib/factory-desktop/update-builder/")||(format==="rpm"&&relative.startsWith("usr/lib/.build-id/"))||NATIVE_PAYLOAD_FILES.has(relative);if(!allowed)throw new Error(`${format}: unexpected package payload path: ${relative}`)}};walk(root);}
function assertExactDebMaintainerScripts(controlRoot){for(const entry of fs.readdirSync(controlRoot,{withFileTypes:true})){if(!entry.isFile()||!DEB_CONTROL_MEMBERS.has(entry.name))throw new Error(`unexpected deb control member: ${entry.name}`)}for(const name of ["postinst","prerm","postrm"]){const actual=path.join(controlRoot,name),expected=path.resolve(__dirname,"..","packaging","linux",`factory-desktop.${name}`);if(!fs.statSync(actual,{throwIfNoEntry:false})?.isFile()||!fs.readFileSync(actual).equals(fs.readFileSync(expected)))throw new Error(`deb maintainer script does not match repository contract: ${name}`)}}
function assertRpmScriptlets(scriptlets){if(scriptlets.postinProgram!=="/bin/sh"||normalizeText(scriptlets.postin)!==normalizeText(RPM_POST_INSTALL))throw new Error("unexpected RPM scriptlet: postin");if(scriptlets.preunProgram!=="/bin/sh"||normalizeText(scriptlets.preun)!==normalizeText(RPM_PRE_UNINSTALL))throw new Error("unexpected RPM scriptlet: preun");for(const name of ["prein","postun"]){if(scriptlets[`${name}Program`]!=="(none)"||scriptlets[name]!=="(none)")throw new Error(`unexpected RPM scriptlet: ${name}`)}}
function expectedFactoryVersion(root,format){const appRoot=format==="appimage"?path.join(root,"usr","lib","factory-desktop"):path.join(root,"opt","Factory");const info=JSON.parse(fs.readFileSync(path.join(appRoot,"build-info.json"),"utf8"));if(typeof info.factoryVersion!=="string")throw new Error(`${format}: build-info factoryVersion missing`);return info.factoryVersion;}
function field(command,args){return execFileSync(command,args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();}

function findNamed(root,name){const found=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.name===name)found.push(f);if(e.isDirectory())walk(f)}};walk(root);return found}
function installedDesktop(root,format){const preferred=format==="appimage"?path.join(root,"factory-desktop.desktop"):path.join(root,"usr","share","applications","factory-desktop.desktop");if(fs.existsSync(preferred))return preferred;return findNamed(root,"factory-desktop.desktop").find((file)=>!file.includes(`${path.sep}update-builder${path.sep}`));}
function inspectExtracted(root,format){const hygiene=scanPackageTree(root,{workspaceRoot:process.cwd()});const desktop=installedDesktop(root,format);if(!desktop)throw new Error(`${format}: factory-desktop.desktop missing`);const text=fs.readFileSync(desktop,"utf8");if(!text.includes("MimeType=x-scheme-handler/factory-desktop;"))throw new Error(`${format}: factory-desktop MimeType missing`);if(!text.includes("StartupWMClass=Factory"))throw new Error(`${format}: StartupWMClass=Factory missing`);
  const appRoot=format==="appimage"?path.join(root,"usr","lib","factory-desktop"):path.join(root,"opt","Factory");assertAcceptedPatchReport(appRoot);
  const services=findNamed(root,"factory-droid-daemon.service").filter((file)=>format==="appimage"||file.includes(`${path.sep}usr${path.sep}lib${path.sep}systemd${path.sep}user${path.sep}`)),updateServices=findNamed(root,"factory-update-manager.service").filter((file)=>format==="appimage"||file.includes(`${path.sep}usr${path.sep}lib${path.sep}systemd${path.sep}user${path.sep}`)),policies=findNamed(root,"org.factory.desktop.update-manager.policy").filter((file)=>format==="appimage"||file.includes(`${path.sep}usr${path.sep}share${path.sep}polkit-1${path.sep}actions${path.sep}`)),updaters=findNamed(root,"factory-update-manager").filter((file)=>format==="appimage"||file.includes(`${path.sep}usr${path.sep}bin${path.sep}`));
  const bundledDroid=findNamed(root,"droid").filter((file)=>file.includes(`${path.sep}resources${path.sep}bin${path.sep}`));if(bundledDroid.length)throw new Error(`${format}: proprietary resources/bin/droid is present`);
  let keyringEnv=false;
  if(format==="appimage"){if(services.length||policies.length||updaters.length)throw new Error("AppImage contains native updater integration");const appRun=findNamed(root,"AppRun")[0];const appRunText=appRun?fs.readFileSync(appRun,"utf8"):"";if(!appRun||!appRunText.includes("FACTORY_UPDATE_MANAGER_UNAVAILABLE"))throw new Error("AppImage AppRun lacks unavailable updater state");keyringEnv=appRunText.includes("FACTORY_DISABLE_KEYRING=1");}
  else {if(!services.length)throw new Error(`${format}: droid daemon service missing`);if(!updateServices.length)throw new Error(`${format}: update-manager service missing`);if(!policies.length)throw new Error(`${format}: polkit policy missing`);if(!updaters.length)throw new Error(`${format}: update-manager binary missing`);keyringEnv=text.includes("FACTORY_DISABLE_KEYRING=1");}
  if(!keyringEnv)throw new Error(`${format}: FACTORY_DISABLE_KEYRING=1 missing`);
  return{format,hygiene,desktop,services:services.length,updateServices:updateServices.length,policies:policies.length,updaters:updaters.length,bundledDroid:bundledDroid.length,keyringEnv,startupWMClass:true,protocolMime:true};}

function inspectPackage(artifact){artifact=path.resolve(artifact);const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),"factory-inspect-"));let root=path.join(tempRoot,"payload"),format,metadata,controlRoot,scriptlets;
  try{
    if(artifact.endsWith(".deb")){format="deb";metadata={name:field("dpkg-deb",["-f",artifact,"Package"]),version:field("dpkg-deb",["-f",artifact,"Version"]),architecture:field("dpkg-deb",["-f",artifact,"Architecture"])};controlRoot=path.join(tempRoot,"control");execFileSync("dpkg-deb",["--control",artifact,controlRoot],{stdio:"ignore"});assertExactDebMaintainerScripts(controlRoot);execFileSync("dpkg-deb",["--contents",artifact],{stdio:"pipe"});execFileSync("dpkg-deb",["--extract",artifact,root],{stdio:"ignore"});}
    else if(artifact.endsWith(".rpm")){format="rpm";const query=tag=>field("rpm",["-qp","--qf",`%{${tag}}`,artifact]);metadata={name:query("NAME"),version:query("VERSION"),architecture:query("ARCH")};scriptlets={postinProgram:query("POSTINPROG"),postin:query("POSTIN"),preinProgram:query("PREINPROG"),prein:query("PREIN"),preunProgram:query("PREUNPROG"),preun:query("PREUN"),postunProgram:query("POSTUNPROG"),postun:query("POSTUN")};assertRpmScriptlets(scriptlets);execFileSync("rpm",["-qlp",artifact],{stdio:"pipe"});fs.mkdirSync(root,{recursive:true});const cpioPath=path.join(root,"payload.cpio"),fd=fs.openSync(cpioPath,"w");try{execFileSync("rpm2cpio",[artifact],{cwd:root,stdio:["ignore",fd,"ignore"]})}finally{fs.closeSync(fd)}execFileSync("cpio",["-idmu","--quiet"],{cwd:root,input:fs.readFileSync(cpioPath),stdio:["pipe","ignore","ignore"]});fs.rmSync(cpioPath);}
    else if(artifact.endsWith(".AppImage")){format="appimage";fs.mkdirSync(root,{recursive:true});execFileSync(artifact,["--appimage-extract"],{cwd:root,env:{...process.env,APPIMAGE_EXTRACT_AND_RUN:"1"},stdio:"ignore"});root=path.join(root,"squashfs-root");}
    else throw new Error(`Unknown package format: ${artifact}`);
    if(format!=="appimage"){assertNativePackageMetadata(format,metadata,expectedFactoryVersion(root,format));assertAllowedNativePayload(root,format);}
    return inspectExtracted(root,format);
  }finally{fs.rmSync(tempRoot,{recursive:true,force:true});}}

if(require.main===module){try{console.log(JSON.stringify(inspectPackage(process.argv[2]),null,2))}catch(e){console.error(`Package inspection failed: ${e.message}`);process.exit(1)}}
module.exports={assertAllowedNativePayload,assertExactDebMaintainerScripts,assertNativePackageMetadata,assertRpmScriptlets,inspectExtracted,inspectPackage};

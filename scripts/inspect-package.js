"use strict";

const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process");
const {scanPackageTree}=require("./package-hygiene");

function findNamed(root,name){const found=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.name===name)found.push(f);if(e.isDirectory())walk(f)}};walk(root);return found}
function inspectExtracted(root,format){const hygiene=scanPackageTree(root,{workspaceRoot:process.cwd()});const desktop=findNamed(root,"factory-desktop.desktop")[0];if(!desktop)throw new Error(`${format}: factory-desktop.desktop missing`);const text=fs.readFileSync(desktop,"utf8");if(!text.includes("MimeType=x-scheme-handler/factory-desktop;"))throw new Error(`${format}: factory-desktop MimeType missing`);if(!text.includes("StartupWMClass=Factory"))throw new Error(`${format}: StartupWMClass=Factory missing`);
  const services=findNamed(root,"factory-droid-daemon.service"),policies=findNamed(root,"org.factory.desktop.update-manager.policy"),updaters=findNamed(root,"factory-update-manager");
  const bundledDroid=findNamed(root,"droid").filter((file)=>file.includes(`${path.sep}resources${path.sep}bin${path.sep}`));if(bundledDroid.length)throw new Error(`${format}: proprietary resources/bin/droid is present`);
  let keyringEnv=false;
  if(format==="appimage"){if(services.length||policies.length||updaters.length)throw new Error("AppImage contains native updater integration");const appRun=findNamed(root,"AppRun")[0];const appRunText=appRun?fs.readFileSync(appRun,"utf8"):"";if(!appRun||!appRunText.includes("FACTORY_UPDATE_MANAGER_UNAVAILABLE"))throw new Error("AppImage AppRun lacks unavailable updater state");keyringEnv=appRunText.includes("FACTORY_DISABLE_KEYRING=1");}
  else {if(!services.length)throw new Error(`${format}: droid daemon service missing`);if(!policies.length)throw new Error(`${format}: polkit policy missing`);keyringEnv=text.includes("FACTORY_DISABLE_KEYRING=1");}
  if(!keyringEnv)throw new Error(`${format}: FACTORY_DISABLE_KEYRING=1 missing`);
  return{format,hygiene,desktop,services:services.length,policies:policies.length,updaters:updaters.length,bundledDroid:bundledDroid.length,keyringEnv,startupWMClass:true,protocolMime:true};}

function inspectPackage(artifact){artifact=path.resolve(artifact);const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),"factory-inspect-"));let root=tempRoot,format;
  try{
    if(artifact.endsWith(".deb")){format="deb";execFileSync("dpkg-deb",["--info",artifact],{stdio:"pipe"});execFileSync("dpkg-deb",["--contents",artifact],{stdio:"pipe"});execFileSync("dpkg-deb",["--extract",artifact,root],{stdio:"ignore"});}
    else if(artifact.endsWith(".rpm")){format="rpm";execFileSync("rpm",["-qpi",artifact],{stdio:"pipe"});execFileSync("rpm",["-qlp",artifact],{stdio:"pipe"});const cpioPath=path.join(root,"payload.cpio"),fd=fs.openSync(cpioPath,"w");try{execFileSync("rpm2cpio",[artifact],{cwd:root,stdio:["ignore",fd,"ignore"]})}finally{fs.closeSync(fd)}execFileSync("cpio",["-idmu","--quiet"],{cwd:root,input:fs.readFileSync(cpioPath),stdio:["pipe","ignore","ignore"]});fs.rmSync(cpioPath);}
    else if(artifact.endsWith(".AppImage")){format="appimage";execFileSync(artifact,["--appimage-extract"],{cwd:root,env:{...process.env,APPIMAGE_EXTRACT_AND_RUN:"1"},stdio:"ignore"});root=path.join(root,"squashfs-root");}
    else throw new Error(`Unknown package format: ${artifact}`);
    return inspectExtracted(root,format);
  }finally{fs.rmSync(tempRoot,{recursive:true,force:true});}}

if(require.main===module){try{console.log(JSON.stringify(inspectPackage(process.argv[2]),null,2))}catch(e){console.error(`Package inspection failed: ${e.message}`);process.exit(1)}}
module.exports={inspectExtracted,inspectPackage};

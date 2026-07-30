"use strict";

const fs=require("node:fs"),https=require("node:https"),os=require("node:os"),path=require("node:path"),stream=require("node:stream/promises");
const {execFileSync}=require("node:child_process");
const {assertPackagedRuntimeLayout,sha256}=require("./runtime");
const {assertAcceptedPatchReport,assertNoBundledDroid}=require("./package-deb");
const {scanPackageTree}=require("./package-hygiene");
const {writePackageBuildInfo}=require("./release-metadata");
const {validateAppJavaScript}=require("./validate-app-javascript");
const {releaseIdentity}=require("./release-identity");

const APPIMAGETOOL_URL="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage";
const APPIMAGETOOL_SHA256="a6d71e2b6cd66f8e8d16c37ad164658985e0cf5fcaa950c90a482890cb9d13e0";
const APPIMAGE_RUNTIME_URL="https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64";
const APPIMAGE_RUNTIME_SHA256="1cc49bcf1e2ccd593c379adb17c9f85a36d619088296504de95b1d06215aebbf";

function download(url,target,redirects=0){if(redirects>5)return Promise.reject(new Error("appimagetool download exceeded redirect limit"));return new Promise((resolve,reject)=>{const request=https.get(url,(response)=>{if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){response.resume();download(new URL(response.headers.location,url).toString(),target,redirects+1).then(resolve,reject);return}if(response.statusCode<200||response.statusCode>=300){response.resume();reject(new Error(`appimagetool download returned HTTP ${response.statusCode}`));return}const output=fs.createWriteStream(target,{mode:0o755});stream.pipeline(response,output).then(resolve,reject)});request.on("error",reject)})}

async function downloadPinned(url,target,digest,name){let error;for(let attempt=1;attempt<=3;attempt++){const temporary=`${target}.partial-${process.pid}-${attempt}`;try{await download(url,temporary);if(sha256(temporary)!==digest)throw new Error(`${name} SHA-256 mismatch`);fs.renameSync(temporary,target);return}catch(candidate){error=candidate;fs.rmSync(temporary,{force:true})}}throw error}

async function resolveTool(cacheDir){const override=process.env.APPIMAGETOOL;if(override){if(sha256(override)!==APPIMAGETOOL_SHA256)throw new Error("APPIMAGETOOL SHA-256 mismatch");return override}const tool=path.join(cacheDir,"appimagetool-x86_64.AppImage");fs.mkdirSync(cacheDir,{recursive:true});if(fs.existsSync(tool)&&sha256(tool)!==APPIMAGETOOL_SHA256)fs.rmSync(tool);if(!fs.existsSync(tool))await downloadPinned(APPIMAGETOOL_URL,tool,APPIMAGETOOL_SHA256,"appimagetool");fs.chmodSync(tool,0o755);return tool}

async function resolveRuntime(cacheDir){const runtime=path.join(cacheDir,"runtime-x86_64");fs.mkdirSync(cacheDir,{recursive:true});if(fs.existsSync(runtime)&&sha256(runtime)!==APPIMAGE_RUNTIME_SHA256)fs.rmSync(runtime);if(!fs.existsSync(runtime))await downloadPinned(APPIMAGE_RUNTIME_URL,runtime,APPIMAGE_RUNTIME_SHA256,"AppImage runtime");return runtime}

async function buildAppImage(options){const appDir=path.resolve(options.appDir),identity=releaseIdentity(options.version,options.wrapperRevision??null),version=identity.factoryVersion;assertPackagedRuntimeLayout(appDir);assertNoBundledDroid(appDir);assertAcceptedPatchReport(appDir);validateAppJavaScript(appDir);scanPackageTree(appDir,{workspaceRoot:process.cwd()});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-appimage-"));try{const appDirRoot=path.join(root,"Factory.AppDir"),runtime=path.join(appDirRoot,"usr","lib","factory-desktop");fs.mkdirSync(runtime,{recursive:true});fs.cpSync(appDir,runtime,{recursive:true,dereference:false});writePackageBuildInfo(runtime,"appimage",{wrapperRevision:identity.wrapperRevision});
  fs.copyFileSync(path.resolve("packaging/appimage/AppRun.template"),path.join(appDirRoot,"AppRun"));fs.chmodSync(path.join(appDirRoot,"AppRun"),0o755);
  fs.copyFileSync(path.resolve("packaging/appimage/factory-desktop.desktop"),path.join(appDirRoot,"factory-desktop.desktop"));fs.copyFileSync(path.resolve("assets/factory-desktop.svg"),path.join(appDirRoot,"factory-desktop.svg"));
  scanPackageTree(appDirRoot,{workspaceRoot:process.cwd()});const cacheDir=path.resolve(options.cacheDir||".cache/appimage"),tool=await resolveTool(cacheDir),runtimeFile=await resolveRuntime(cacheDir),outputDir=path.resolve(options.outputDir||"dist"),output=path.join(outputDir,identity.appImageFilename);fs.mkdirSync(outputDir,{recursive:true});fs.rmSync(output,{force:true});
  execFileSync(tool,["--runtime-file",runtimeFile,appDirRoot,output],{env:{...process.env,ARCH:"x86_64",APPIMAGE_EXTRACT_AND_RUN:"1"},stdio:"inherit",timeout:10*60*1000});fs.chmodSync(output,0o755);
  const inspect=path.join(root,"inspect");fs.mkdirSync(inspect);execFileSync(output,["--appimage-extract"],{cwd:inspect,env:{...process.env,APPIMAGE_EXTRACT_AND_RUN:"1"},stdio:"ignore",timeout:10*60*1000});const extracted=path.join(inspect,"squashfs-root");scanPackageTree(extracted,{workspaceRoot:process.cwd()});
  if(fs.existsSync(path.join(extracted,"usr","bin","factory-update-manager")))throw new Error("Portable AppImage must not contain factory-update-manager");
  if(fs.existsSync(path.join(extracted,"usr","lib","factory-desktop","update-bridge.cjs")))throw new Error("Portable AppImage must not contain update-bridge.cjs");
  for(const forbidden of ["factory-droid-daemon.service","org.factory.desktop.update-manager.policy"]){let found=false;const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.name===forbidden)found=true;else if(e.isDirectory())walk(f)}};walk(extracted);if(found)throw new Error(`Portable AppImage must not contain ${forbidden}`)}
  const desktop=fs.readFileSync(path.join(extracted,"factory-desktop.desktop"),"utf8");if(!desktop.includes("MimeType=x-scheme-handler/factory-desktop;"))throw new Error("AppImage desktop entry lacks factory-desktop MimeType");
  return{path:output,sha256:sha256(output),bytes:fs.statSync(output).size};}finally{fs.rmSync(root,{recursive:true,force:true});}}

if(require.main===module){const[appDir,version,outputDir]=process.argv.slice(2);buildAppImage({appDir,version,outputDir}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(`AppImage build failed: ${e.message}`);process.exit(1)})}
module.exports={buildAppImage};

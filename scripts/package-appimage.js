"use strict";

const fs=require("node:fs"),https=require("node:https"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process");
const {assertPackagedRuntimeLayout,sha256}=require("./runtime");
const {assertAcceptedPatchReport,assertNoBundledDroid}=require("./package-deb");
const {scanPackageTree}=require("./package-hygiene");

function download(url,target){return new Promise((resolve,reject)=>{const request=https.get(url,(response)=>{if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){response.resume();download(new URL(response.headers.location,url).toString(),target).then(resolve,reject);return}if(response.statusCode<200||response.statusCode>=300){response.resume();reject(new Error(`appimagetool download returned HTTP ${response.statusCode}`));return}const output=fs.createWriteStream(target,{mode:0o755});response.pipe(output);output.on("finish",()=>output.close(resolve));output.on("error",reject)});request.on("error",reject)})}

async function resolveTool(cacheDir){if(process.env.APPIMAGETOOL)return process.env.APPIMAGETOOL;try{return execFileSync("sh",["-lc","command -v appimagetool"],{encoding:"utf8"}).trim()}catch{}const tool=path.join(cacheDir,"appimagetool-x86_64.AppImage");if(!fs.existsSync(tool)){fs.mkdirSync(cacheDir,{recursive:true});await download("https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage",tool)}fs.chmodSync(tool,0o755);return tool}

async function buildAppImage(options){const appDir=path.resolve(options.appDir),version=options.version;assertPackagedRuntimeLayout(appDir);assertNoBundledDroid(appDir);assertAcceptedPatchReport(appDir);scanPackageTree(appDir,{workspaceRoot:process.cwd()});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-appimage-"));try{const appDirRoot=path.join(root,"Factory.AppDir"),runtime=path.join(appDirRoot,"usr","lib","factory-desktop");fs.mkdirSync(runtime,{recursive:true});fs.cpSync(appDir,runtime,{recursive:true,dereference:false});
  fs.copyFileSync(path.resolve("packaging/appimage/AppRun.template"),path.join(appDirRoot,"AppRun"));fs.chmodSync(path.join(appDirRoot,"AppRun"),0o755);
  fs.copyFileSync(path.resolve("packaging/appimage/factory-desktop.desktop"),path.join(appDirRoot,"factory-desktop.desktop"));fs.copyFileSync(path.resolve("assets/factory-desktop.svg"),path.join(appDirRoot,"factory-desktop.svg"));
  scanPackageTree(appDirRoot,{workspaceRoot:process.cwd()});const tool=await resolveTool(path.resolve(options.cacheDir||".cache/appimage"));const outputDir=path.resolve(options.outputDir||"dist"),output=path.join(outputDir,`Factory-${version}-x86_64.AppImage`);fs.mkdirSync(outputDir,{recursive:true});fs.rmSync(output,{force:true});
  execFileSync(tool,[appDirRoot,output],{env:{...process.env,ARCH:"x86_64",APPIMAGE_EXTRACT_AND_RUN:"1"},stdio:"inherit",timeout:10*60*1000});fs.chmodSync(output,0o755);
  const inspect=path.join(root,"inspect");fs.mkdirSync(inspect);execFileSync(output,["--appimage-extract"],{cwd:inspect,env:{...process.env,APPIMAGE_EXTRACT_AND_RUN:"1"},stdio:"ignore",timeout:10*60*1000});const extracted=path.join(inspect,"squashfs-root");scanPackageTree(extracted,{workspaceRoot:process.cwd()});
  if(fs.existsSync(path.join(extracted,"usr","bin","factory-update-manager")))throw new Error("Portable AppImage must not contain factory-update-manager");
  if(fs.existsSync(path.join(extracted,"usr","lib","factory-desktop","update-bridge.cjs")))throw new Error("Portable AppImage must not contain update-bridge.cjs");
  for(const forbidden of ["factory-droid-daemon.service","org.factory.desktop.update-manager.policy"]){let found=false;const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.name===forbidden)found=true;else if(e.isDirectory())walk(f)}};walk(extracted);if(found)throw new Error(`Portable AppImage must not contain ${forbidden}`)}
  const desktop=fs.readFileSync(path.join(extracted,"factory-desktop.desktop"),"utf8");if(!desktop.includes("MimeType=x-scheme-handler/factory-desktop;"))throw new Error("AppImage desktop entry lacks factory-desktop MimeType");
  return{path:output,sha256:sha256(output),bytes:fs.statSync(output).size};}finally{fs.rmSync(root,{recursive:true,force:true});}}

if(require.main===module){const[appDir,version,outputDir]=process.argv.slice(2);buildAppImage({appDir,version,outputDir}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(`AppImage build failed: ${e.message}`);process.exit(1)})}
module.exports={buildAppImage};

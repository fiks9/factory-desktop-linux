#!/usr/bin/env node
"use strict";

const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {execFileSync}=require("node:child_process");
const asar=require(require.resolve("@electron/asar",{paths:[path.resolve(__dirname,"..","patcher")]}));

function syntheticBundle(){return `function BVe(){return fc.Ipc}function dv(){return"droid-dev"}async function start(){return resolveTransportMode()}function resolveTransportMode(){return BVe()}function daemon(){let r;if(W.app.isPackaged)r=X.join(process.resourcesPath,"bin",process.platform==="win32"?"droid.exe":"droid");else r=dv();const t=fc.Ipc&&a.push("--listen","ipc");W.app.isPackaged||a.push("--debug");const h={transportMode:t};/* --enable-child-ipc */}W.autoUpdater.checkForUpdates();W.autoUpdater.quitAndInstall();async startInternal(){this.state=Hn.Starting;this.currentPort=r;let l;if(r!==null){spawn()}}`;}

async function createSyntheticDmg(output,version="0.139.0",electronVersion="42.3.3"){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-synthetic-dmg-"));try{const contents=path.join(root,"Factory","Factory.app","Contents"),source=path.join(root,"asar-source");fs.mkdirSync(path.join(contents,"Resources"),{recursive:true});fs.mkdirSync(path.join(contents,"Frameworks","Electron Framework.framework","Versions","A","Resources"),{recursive:true});fs.mkdirSync(path.join(source,".vite","build"),{recursive:true});fs.writeFileSync(path.join(source,".vite","build","index.js"),syntheticBundle());await asar.createPackage(source,path.join(contents,"Resources","app.asar"));
    fs.writeFileSync(path.join(contents,"Info.plist"),`<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);fs.writeFileSync(path.join(contents,"Frameworks","Electron Framework.framework","Versions","A","Resources","Info.plist"),`<plist><dict><key>CFBundleVersion</key><string>${electronVersion}</string></dict></plist>`);
    output=path.resolve(output);fs.mkdirSync(path.dirname(output),{recursive:true});fs.rmSync(output,{force:true});execFileSync(process.env.SEVEN_ZIP||"7z",["a","-t7z",output,"Factory"],{cwd:root,stdio:"ignore"});return output;
  }finally{fs.rmSync(root,{recursive:true,force:true});}}

if(require.main===module)createSyntheticDmg(process.argv[2],process.argv[3],process.argv[4]).then(console.log).catch(e=>{console.error(e.message);process.exit(1)});
module.exports={createSyntheticDmg,syntheticBundle};

#!/usr/bin/env node
"use strict";

const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),zlib=require("node:zlib");
const {execFileSync}=require("node:child_process");
const asar=require(require.resolve("@electron/asar",{paths:[path.resolve(__dirname,"..","patcher")]}));

function crc32(buffer){let crc=0xffffffff;for(const byte of buffer){crc^=byte;for(let bit=0;bit<8;bit+=1)crc=(crc>>>1)^(0xedb88320&-(crc&1));}return(crc^0xffffffff)>>>0;}
function pngChunk(type,data){const name=Buffer.from(type,"ascii"),chunk=Buffer.alloc(12+data.length);chunk.writeUInt32BE(data.length,0);name.copy(chunk,4);data.copy(chunk,8);chunk.writeUInt32BE(crc32(Buffer.concat([name,data])),8+data.length);return chunk;}
function syntheticPng(size=512){const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header.set([8,6,0,0,0],8);const row=Buffer.alloc(1+size*4);for(let i=1;i<row.length;i+=4)row.set([23,23,23,255],i);const pixels=Buffer.concat(Array.from({length:size},()=>row));return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),pngChunk("IHDR",header),pngChunk("IDAT",zlib.deflateSync(pixels)),pngChunk("IEND",Buffer.alloc(0))]);}
function syntheticIcns(){const png=syntheticPng(),entry=Buffer.alloc(8+png.length);entry.write("ic09",0,4,"ascii");entry.writeUInt32BE(entry.length,4);png.copy(entry,8);const header=Buffer.alloc(8);header.write("icns",0,4,"ascii");header.writeUInt32BE(header.length+entry.length,4);return Buffer.concat([header,entry]);}
function syntheticBundle(){return `function BVe(){return fc.Ipc}function dv(){return"droid-dev"}async function start(){return resolveTransportMode()}function resolveTransportMode(){return BVe()}function daemon(){let r;if(W.app.isPackaged)r=X.join(process.resourcesPath,"bin",process.platform==="win32"?"droid.exe":"droid");else r=dv();const t=fc.Ipc&&a.push("--listen","ipc");W.app.isPackaged||a.push("--debug");const h={transportMode:t};/* --enable-child-ipc */}const win32=process.platform==="win32",factoryWindow=new W.BrowserWindow({titleBarStyle:win32?"default":"hidden",trafficLightPosition:win32?void 0:{x:12,y:10},webPreferences:{}});W.ipcMain.handle("updates:getState",async()=>legacyGetState());W.ipcMain.handle("updates:install",async()=>legacyInstall());W.ipcMain.handle("updates:checkNow",async()=>legacyCheckNow());W.autoUpdater.checkForUpdates();W.autoUpdater.quitAndInstall();const daemonController={async startInternal(){this.state=Hn.Starting;this.currentPort=r;let l;if(r!==null){spawn()}}}`;}

async function createSyntheticDmg(output,version="0.139.0",electronVersion="42.3.3"){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-synthetic-dmg-"));try{const contents=path.join(root,"Factory","Factory.app","Contents"),source=path.join(root,"asar-source");fs.mkdirSync(path.join(contents,"Resources"),{recursive:true});fs.mkdirSync(path.join(contents,"Frameworks","Electron Framework.framework","Versions","A","Resources"),{recursive:true});fs.writeFileSync(path.join(contents,"Resources","electron.icns"),syntheticIcns());fs.mkdirSync(path.join(source,".vite","build"),{recursive:true});fs.writeFileSync(path.join(source,".vite","build","index.js"),syntheticBundle());await asar.createPackage(source,path.join(contents,"Resources","app.asar"));
    fs.writeFileSync(path.join(contents,"Info.plist"),`<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);fs.writeFileSync(path.join(contents,"Frameworks","Electron Framework.framework","Versions","A","Resources","Info.plist"),`<plist><dict><key>CFBundleVersion</key><string>${electronVersion}</string></dict></plist>`);
    output=path.resolve(output);fs.mkdirSync(path.dirname(output),{recursive:true});fs.rmSync(output,{force:true});execFileSync(process.env.SEVEN_ZIP||"7z",["a","-t7z",output,"Factory"],{cwd:root,stdio:"ignore"});return output;
  }finally{fs.rmSync(root,{recursive:true,force:true});}}

if(require.main===module)createSyntheticDmg(process.argv[2],process.argv[3],process.argv[4]).then(console.log).catch(e=>{console.error(e.message);process.exit(1)});
module.exports={createSyntheticDmg,syntheticBundle,syntheticPng};

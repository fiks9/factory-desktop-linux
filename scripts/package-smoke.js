#!/usr/bin/env node
"use strict";

const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {createSyntheticDmg}=require("./create-synthetic-dmg"),{buildApp}=require("./build-app"),{buildDeb}=require("./package-deb"),{buildRpm}=require("./package-rpm"),{buildAppImage}=require("./package-appimage"),{inspectPackage}=require("./inspect-package");

async function packageSmoke(options={}){const version=options.version||"0.139.0",root=fs.mkdtempSync(path.join(os.tmpdir(),"factory-package-smoke-"));try{const dmg=await createSyntheticDmg(path.join(root,"Factory-synthetic.dmg"),version,"42.3.3"),built=await buildApp({dmg,version,cacheDir:path.join(root,"downloads"),workDir:path.join(root,"work")}),outputDir=path.resolve(options.outputDir||"dist");
  const artifacts=[buildDeb({appDir:built.appDir,version,outputDir}),buildRpm({appDir:built.appDir,version,outputDir}),await buildAppImage({appDir:built.appDir,version,outputDir,cacheDir:path.join(root,"appimage-cache")})];
  return artifacts.map(artifact=>({...artifact,inspection:inspectPackage(artifact.path)}));}finally{fs.rmSync(root,{recursive:true,force:true});}}

if(require.main===module)packageSmoke({outputDir:process.argv[2],version:process.argv[3]}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(`Package smoke failed: ${error.message}`);process.exit(1)});
module.exports={packageSmoke};

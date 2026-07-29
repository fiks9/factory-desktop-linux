#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { patchAsar } = require("./engine");

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const asarPath = value("--asar");
const reportPath = value("--report") || (asarPath ? path.join(path.dirname(asarPath), "patch-report.json") : undefined);
if (!asarPath) {
  console.error("Usage: node patcher/src/cli.js --asar /absolute/app.asar [--report /absolute/patch-report.json]");
  process.exit(2);
}
patchAsar({ asarPath, reportPath }).then((report) => {
  console.log(JSON.stringify(report, null, 2));
}).catch((error) => {
  if (error.report) {
    console.error(JSON.stringify(error.report, null, 2));
  } else {
    console.error(`Patch failed: ${error.message}`);
  }
  process.exit(1);
});

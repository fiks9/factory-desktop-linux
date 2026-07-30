"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { makeFiles } = require("../patcher/src/engine");
const { validateJavaScriptFiles } = require("../patcher/src/javascript-syntax");

function validateAppJavaScript(appDir) {
  const asarPath = path.join(path.resolve(appDir), "resources", "app.asar");
  if (!fs.statSync(asarPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Bundle JavaScript syntax validation requires resources/app.asar: ${asarPath}`);
  }
  const validation = validateJavaScriptFiles(makeFiles(asarPath));
  if (!validation.validationPassed) {
    const error = new Error(`Bundle JavaScript syntax validation failed: ${validation.errors.join("; ")}`);
    error.validation = validation;
    throw error;
  }
  return validation;
}

module.exports = { validateAppJavaScript };

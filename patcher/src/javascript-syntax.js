"use strict";

const vm = require("node:vm");

function markerBearing(file) {
  return /factory-linux:[a-z0-9-]+/.test(file.content);
}

function validateJavaScriptFiles(files, options = {}) {
  const changedPaths = options.changedPaths || new Set();
  const selected = files.filter((file) => changedPaths.has(file.path) || markerBearing(file));
  const failures = [];
  for (const file of selected) {
    try {
      new vm.Script(file.content, { filename: file.path, displayErrors: true });
    } catch (error) {
      failures.push({
        file: file.path,
        message: String(error.message).slice(0, 512),
      });
    }
  }
  if (selected.length === 0) {
    failures.push({ file: null, message: "No changed or Factory-marker-bearing JavaScript bundle was found" });
  }
  return {
    validationPassed: failures.length === 0,
    errors: failures.map((failure) => failure.file ? `${failure.file}: ${failure.message}` : failure.message),
    evidence: {
      mode: "commonjs-script",
      checkedFiles: selected.length,
      files: selected.map((file) => file.path),
      failures,
    },
  };
}

module.exports = { validateJavaScriptFiles };

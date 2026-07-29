#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const required = [
  "README.md",
  "LICENSE",
  ".gitignore",
  "Makefile",
  "docs/architecture.md",
  "docs/legal-and-artifact-policy.md",
  "patcher/package.json",
  "updater/Cargo.toml",
];

for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) {
    throw new Error(`Phase 0 contract is missing: ${relative}`);
  }
}

if (process.argv[2] === "typecheck") {
  process.stdout.write("Phase 0 TypeScript contract check passed.\n");
}

#!/usr/bin/env node

"use strict";

const CRITICAL_POLICY = "required-upstream";
const OPTIONAL_POLICY = "optional";

function assertDescriptor(descriptor) {
  const required = ["id", "description", "phase", "ciPolicy", "matchStrategy", "migrationMarkers", "validate"];
  for (const field of required) {
    if (!(field in descriptor)) {
      throw new Error(`Patch descriptor is missing ${field}`);
    }
  }
  if (![CRITICAL_POLICY, OPTIONAL_POLICY].includes(descriptor.ciPolicy)) {
    throw new Error(`Unknown patch policy: ${descriptor.ciPolicy}`);
  }
  return descriptor;
}

if (require.main === module && process.argv.includes("--typecheck")) {
  assertDescriptor({
    id: "phase0-contract",
    description: "Phase 0 descriptor contract",
    phase: "main-bundle",
    ciPolicy: CRITICAL_POLICY,
    matchStrategy: "structural",
    migrationMarkers: ["factory-linux:phase0-contract"],
    validate: () => true,
  });
  process.stdout.write("Patch descriptor contract check passed.\n");
}

module.exports = { CRITICAL_POLICY, OPTIONAL_POLICY, assertDescriptor };

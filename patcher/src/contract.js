#!/usr/bin/env node

"use strict";

export const CRITICAL_POLICY = "required-upstream";
export const OPTIONAL_POLICY = "optional";

export function assertDescriptor(descriptor) {
  const required = ["id", "description", "phase", "ciPolicy", "matchStrategy", "validate"];
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

if (process.argv.includes("--typecheck")) {
  assertDescriptor({
    id: "phase0-contract",
    description: "Phase 0 descriptor contract",
    phase: "main-bundle",
    ciPolicy: CRITICAL_POLICY,
    matchStrategy: "structural",
    validate: () => true,
  });
  process.stdout.write("Patch descriptor contract check passed.\n");
}

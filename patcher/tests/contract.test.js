const test = require("node:test");
const assert = require("node:assert/strict");
const { assertDescriptor, CRITICAL_POLICY } = require("../src/contract.js");

test("required patch descriptors have an explicit fail-closed policy", () => {
  const descriptor = assertDescriptor({
    id: "daemon-transport-force-websocket",
    description: "Force websocket transport on Linux",
    phase: "main-bundle",
    ciPolicy: CRITICAL_POLICY,
    matchStrategy: "structural",
    migrationMarkers: ["factory-linux-daemon-transport"],
    validate: () => true,
  });

  assert.equal(descriptor.ciPolicy, "required-upstream");
  assert.equal(descriptor.matchStrategy, "structural");
});

test("missing descriptor fields fail instead of being silently accepted", () => {
  assert.throws(
    () => assertDescriptor({ id: "incomplete" }),
    /missing description/,
  );
});

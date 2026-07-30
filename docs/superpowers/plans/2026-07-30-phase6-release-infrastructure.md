# Phase 6 Release Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fail-closed upstream monitoring, GitHub release automation, verified provenance/checksums, drift diagnostics, and complete maintainer operations documentation.

**Architecture:** Thin GitHub workflows invoke repository-owned Node contract scripts layered over the existing build and package pipeline. Provenance is embedded per package and aggregated into a release manifest; all publication waits for package extraction inspection and a final acceptance verdict.

**Tech Stack:** GitHub Actions, Node.js CommonJS, existing Rust updater tests, deb/rpm/AppImage tooling, GitHub CLI.

---

### Task 1: Release Contract Tests

**Files:**
- Create: `tests/release-infrastructure.test.js`
- Create: `release/accepted-upstream.json`

- [x] Write failing tests for accepted-version comparison, strict metadata,
  provenance fields, exact checksums, package-format binding, diagnostic bounds,
  workflow permissions, and regression matrix coverage.
- [x] Run `node --test tests/release-infrastructure.test.js` and confirm failures
  are caused by missing Phase 6 scripts and workflows.

### Task 2: Provenance And Checksums

**Files:**
- Create: `scripts/release-metadata.js`
- Modify: `scripts/build-app.js`
- Modify: `scripts/package-deb.js`
- Modify: `scripts/package-rpm.js`
- Modify: `scripts/package-appimage.js`
- Modify: `scripts/inspect-package.js`

- [x] Implement strict source provenance and package-specific metadata writers.
- [x] Generate and verify exact sorted SHA-256 coverage for release assets.
- [x] Validate embedded package format/native identity during extraction.
- [x] Run the targeted release contract tests until green.

### Task 3: Drift Diagnostics And Release Builder

**Files:**
- Create: `scripts/patch-diagnostics.js`
- Create: `scripts/release-build.js`
- Create: `scripts/upstream-watch.js`
- Modify: `patcher/src/engine.js`

- [x] Write bounded diagnostics on critical patch failure without copying ASAR.
- [x] Build the exact-version release bundle and write acceptance metadata only
  after all packages pass hygiene and extraction inspection.
- [x] Implement latest-version comparison and machine-readable watch outcomes.
- [x] Verify failure stops before packaging and diagnostics contain required
  matcher/validator evidence.

### Task 4: Workflows And Release Gate

**Files:**
- Create: `.github/workflows/upstream-watch.yml`
- Create: `.github/workflows/release.yml`
- Create: `scripts/release-check.js`
- Modify: `.github/workflows/package-smoke.yml`
- Modify: `Makefile`

- [x] Add daily/manual upstream watch with issue dedupe and job summaries.
- [x] Add manual exact-version/ref release flow with read-only build permissions
  and write access only in the final publication job.
- [x] Add `make release-check` with source-status preservation, generated artifact
  hygiene, synthetic/real gates, and provenance/checksum verification.
- [x] Run workflow contract tests and `make release-check`.

### Task 5: Maintainer Documentation

**Files:**
- Create: `docs/maintainer-runbook.md`
- Create: `docs/release-process.md`
- Create: `docs/patch-drift.md`
- Create: `docs/security-model.md`
- Create: `docs/troubleshooting.md`
- Modify: `README.md`
- Modify: `docs/roadmap.md`

- [x] Document pinned builds, package inspection, all stable commands, drift,
  daemon/keyring/protocol/polkit debugging, rollback, safe cache cleanup, and
  release publication.
- [x] Document checksum-only mode and the inactive passwordless policy without
  claiming fully unattended updates.
- [x] Update the final regression matrix with explicit real-fixture SKIP rules.

### Task 6: Final Acceptance And Commit

**Files:** all Phase 6 files

- [x] Run `cargo fmt --all`, clippy with warnings denied, and `cargo test`.
- [x] Run `make check`, `make test`, package smoke, real bundle harness, and
  `make release-check` sequentially.
- [x] Remove exact temporary output directories and run `git diff --check`.
- [x] Review workflow permissions, staged source-only files, and final tree.
- [x] Create one commit named
  `feat(phase6): add release automation and maintainer tooling` without push.

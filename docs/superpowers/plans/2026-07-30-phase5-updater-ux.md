# Phase 5 Updater UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a fail-closed native updater UX with controlled app-exit installation, verified relaunch, deduplicated notifications, and inactive-but-complete root approval architecture.

**Architecture:** Rust owns state, process orchestration, notifications, package verification, and root approvals. A fixed package-owned CommonJS bridge adapts the existing Electron update IPC contract to the Rust CLI; the ASAR patch only loads that bridge and replaces three known handlers.

**Tech Stack:** Rust 1.96, serde/chrono/clap/fs4/sha2, Node.js CommonJS, Electron main-process APIs, deb/rpm/AppImage builders and inspectors.

---

### Task 1: State Schema And Status Contract

**Files:** `updater/src/state.rs`, `updater/src/main.rs`, `updater/tests/foundation.rs`, `updater/tests/cli.rs`

- [x] Add failing tests for schema-1 migration, schema-2 round-trip, sanitized status envelope, `kind` mapping, and separate `manualCommand`.
- [x] Run targeted Rust tests and confirm failures are caused by missing schema-2 fields.
- [x] Implement backward-compatible deserialization and external status view; never expose arbitrary renderer executable input.
- [x] Run targeted tests and keep all Phase 4 tests green.

### Task 2: Notification Dedupe

**Files:** `updater/src/notify.rs`, `updater/src/main.rs`, `updater/tests/notify.rs`

- [x] Add failing tests using an injected notification backend for candidate/status dedupe and event changes.
- [x] Implement deterministic keys, persisted delivery, bounded message text, `notify-send`, and fallback behavior.
- [x] Verify ready/manual/installed/rollback/rejected events and no interval spam.

### Task 3: Controlled After-Exit Install

**Files:** `updater/src/after_exit.rs`, `updater/src/process.rs`, `updater/src/main.rs`, `updater/src/paths.rs`, `updater/tests/after_exit.rs`

- [x] Add failing tests for bounded process wait, duplicate lock, verified install/rollback relaunch once, manual action no loop, and relaunch failure state preservation.
- [x] Implement `prepare-install`, hidden/internal `after-exit`, fixed executable/launcher identities, and dependency-injected process control.
- [x] Add `reconcile-install` tests and implementation using package-manager version queries.
- [x] Verify no install runs while Factory remains alive and no terminal failure loops.

### Task 4: Root Approval Records

**Files:** `updater/src/approval.rs`, `updater/src/main.rs`, `updater/src/polkit.rs`, `updater/tests/approval.rs`, `packaging/linux/org.factory.desktop.update-manager.policy`

- [x] Add failing positive and negative tests for approval ID grammar, traversal, symlink, owner/mode, metadata, version, hash, patch-report hash, expiry, atomic consume, replay, and arbitrary path rejection.
- [x] Implement request parsing, authenticated root staging, strict record format, cache confinement, permission/ownership checks, and consume-before-install.
- [x] Implement `setup-unattended`, `approve-candidate`, and `install-approved-package <approval-id>` without enabling passwordless policy.
- [x] Verify `unattended` remains off by default and policy remains `allow_active=no`.

### Task 5: Package-Owned Electron Bridge

**Files:** `packaging/linux/update-bridge.cjs`, `tests/update-bridge.test.js`, `patcher/src/patches.js`, `patcher/src/validators.js`, `patcher/tests/patcher.test.js`

- [x] Add failing bridge tests for every Rust state, helper missing/timeout/invalid JSON/schema, text sanitization, action whitelist, dialog parenting/dedupe, copy-only behavior, and install confirmation.
- [x] Implement a dependency-injected CommonJS bridge with fixed production helper path and bounded subprocesses.
- [x] Add failing ASAR tests for one load, three handler replacements, and drift rejection; implement the minimal structural patch and validator.
- [x] Verify the remote renderer receives only compatible state and fixed whitelisted actions.

### Task 6: Packaging Contracts

**Files:** `scripts/package-deb.js`, `scripts/package-rpm.js`, `scripts/inspect-package.js`, `tests/package-hygiene.test.js`, `docs/update-manager.md`, `README.md`

- [x] Add failing inspection tests for the fixed bridge path, mode, native-only presence, and policy inactivity.
- [x] Stage the bridge into deb/rpm as mode 0644 below `/usr/lib/factory-desktop`; keep it absent from AppImage.
- [x] Update docs without claiming fully unattended updates.
- [x] Run Node tests and package inspection.

### Task 7: Acceptance And Commit

**Files:** all Phase 5 files

- [x] Run `cargo fmt`, clippy with warnings denied, all Rust tests, `make check`, and `make test`.
- [x] Run synthetic deb/rpm/AppImage smoke and the real 0.139.0 harness with bounded temp roots.
- [ ] Perform only non-destructive Mint live checks authorized by the user; do not downgrade or rollback.
- [ ] Clean generated artifacts, run `git diff --check`, review the full diff, and create one Phase 5 commit without push.

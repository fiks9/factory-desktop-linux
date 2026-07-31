# Factory Theme-Aware Window Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize Linux Electron window controls with Factory's selected light, dark, or system theme.

**Architecture:** Extend the existing fail-closed `linux-window-controls` ASAR patch. Reuse Factory's validated `window:setThemeSource` to drive Electron `nativeTheme`, then update each BrowserWindow overlay on `nativeTheme.updated` and remove the listener on close.

**Tech Stack:** Node.js, Electron BrowserWindow/nativeTheme contracts, `@electron/asar`, Node test runner.

---

### Task 1: Lock The Adaptive Overlay Contract In Tests

**Files:**
- Modify: `patcher/tests/patcher.test.js`

- [x] Add assertions that the patched bundle contains Factory light/dark colors, `nativeTheme.shouldUseDarkColors`, one `nativeTheme.on("updated", ...)`, one `setTitleBarOverlay(...)`, and one matching `removeListener("updated", ...)` cleanup.
- [x] Add a focused harness that evaluates the injected helper with fake `nativeTheme` and BrowserWindow objects, changes `shouldUseDarkColors`, emits `updated`, and observes the expected overlay.
- [x] Run `node --test patcher/tests/patcher.test.js` and confirm the new assertions fail because the current patch contains the static `#171717` overlay.

### Task 2: Implement Structural Theme Synchronization

**Files:**
- Modify: `patcher/src/patches.js`
- Modify: `patcher/src/validators.js`
- Modify: `patcher/src/engine.js`

- [x] Extend the BrowserWindow matcher to capture the Electron alias and BrowserWindow variable while retaining the exact title-bar and traffic-light anchors.
- [x] Emit an initial Linux overlay using `nativeTheme.shouldUseDarkColors`, Factory colors, and the measured 26-pixel title-strip height.
- [x] Insert one per-window apply function after the matching `const <webContents>=<window>.webContents` anchor.
- [x] On Linux, apply once, subscribe to `nativeTheme.updated`, and remove the same listener from `nativeTheme` on BrowserWindow `closed`.
- [x] Update migration markers and validation counts so old static overlays, missing cleanup, duplicate listeners, or ambiguous anchors fail closed.
- [x] Run `node --test patcher/tests/patcher.test.js` and confirm the focused suite passes.

### Task 3: Verify Repository Contracts

**Files:**
- Modify only if a contract test proves a required expectation is missing.

- [x] Run `npm --prefix patcher run check`.
- [x] Run `make check`.
- [x] Run `make test`.
- [x] Run `cargo clippy --all-targets -- -D warnings` and `cargo test` from `updater/`.
- [x] Run `git diff --check` and inspect the complete diff.

### Task 4: Build And Inspect The Local Native Package

**Files:**
- No tracked files; generated output stays under one restrictive temporary root.

- [x] Create one bounded temporary root with `mktemp -d`, permissions `0700`, and a cleanup trap.
- [x] Build the exact Factory 0.142.0 app with the accepted content-addressed DMG.
- [x] Build the Debian package with a new local wrapper revision so apt performs a real upgrade.
- [x] Inspect the package, patch report, provenance, ownership, icon, bridge, and `allow_active=no` policy before installation.

### Task 5: Install And Manually Verify

**Files:**
- No repository changes.

- [x] Close Factory cleanly and verify the app process exits.
- [x] Ask the user to run the exact `sudo apt-get install --reinstall` command for the verified local package.
- [x] Launch Factory as the user and verify controls in `System`, explicit `Light`, and explicit `Dark` modes.
- [x] Verify package version, services, updater state, Droid health, user configuration retention, and `allow_active=no`.
- [x] Keep the repository uncommitted until the user confirms the visual result and explicitly requests commit/push.

# Roadmap

## Phase 0

Repository skeleton, wrapper-only policy, Makefile, and basic CI contracts.

## Phase 1

Deterministic local build: Factory endpoint discovery, content-addressed DMG
cache, extraction, Linux Electron runtime, launcher, and Debian packaging.

## Phase 2

Patch engine with required transport, `--listen ipc`, system Droid resolver,
daemon adoption, keyring, protocol, native updater, and auto-updater patches.
Each patch has a report entry and post-patch validator.

## Phase 3

Blocking package hygiene gate, AppImage, and clean update-builder staging.

## Phase 4

Rust updater MVP: metadata checks, status, user-triggered preparation, install,
rollback, state machine, workspaces, content-addressed downloads, and
known-good retention. Native packages carry the updater; AppImage stays
updater-unavailable. Startup and daemon checks do not prepare candidates.

## Phase 5

In-app update UX with a visible Update action, metadata-only startup/daemon
checks, user-triggered download/build/validation, polkit authentication only
after preparation, controlled application exit, automatic relaunch, terminal
fallback, and opt-in approval preparation backed by root-side approval and
attestation. `updates:install` starts the operation and does not quit the app
before preparation. One process restart remains necessary for new Electron code
to load, but it is performed automatically; users do not manually restart.
User-owned manifests, package paths, and hashes are not sufficient
authorization for root installation. Passwordless activation remains blocked
until a separate privileged live E2E verdict; Phase 5 does not claim fully
unattended updates.

## Phase 6

Daily upstream monitoring, automatic exact-version release dispatch, package-
bound provenance, exact checksums, bounded patch drift diagnostics, blocking
local release gates, and maintainer operations documentation. GitHub publication
is possible only after the complete acceptance and package inspection verdict.

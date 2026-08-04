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

Rust updater MVP: check, status, rebuild, install, rollback, state machine,
workspaces, content-addressed downloads, and known-good retention. Native
packages carry the updater; AppImage stays updater-unavailable.

## Phase 5

In-app update UX, app-exit installation, polkit detection, terminal fallback,
and opt-in approval preparation backed by root-side approval and attestation.
User-owned manifests, package paths, and hashes are not sufficient authorization
for root installation. Passwordless activation remains blocked until a separate
privileged live E2E verdict; Phase 5 does not claim fully unattended updates.

## Phase 6

Daily upstream monitoring, automatic exact-version release dispatch, package-
bound provenance, exact checksums, bounded patch drift diagnostics, blocking
local release gates, and maintainer operations documentation. GitHub publication
is possible only after the complete acceptance and package inspection verdict.

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
workspaces, content-addressed downloads, and known-good retention.

## Phase 5

In-app update UX, app-exit installation, polkit detection, terminal fallback,
and opt-in unattended installation.

## Phase 6

Scheduled upstream watch, checksummed releases, patch reports, and maintainer
runbook.

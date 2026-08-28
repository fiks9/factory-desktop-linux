# Architecture

The project converts an authorized Factory Desktop macOS DMG into a Linux
application without storing the upstream payload in this repository.

## Phase Boundaries

1. Phase 0 defines repository, legal, testing, and generated-artifact
   contracts.
2. Phase 1 added deterministic DMG caching/extraction and a minimal Debian
   package.
3. Phase 2 added required ASAR patch descriptors and post-patch validators.
4. Phase 3 added package hygiene, AppImage, and update-builder staging.
5. Phase 4 added the Rust update manager and transactional installation.
6. Phase 5 connected the in-app update UX, metadata-only checks, user-triggered
   candidate preparation, polkit authentication, and controlled relaunch.
7. Phase 6 adds scheduled upstream checks, release gates, and provenance.

## Runtime Update Lifecycle

Startup and daemon checks are intentionally metadata-only. The updater queries
the latest exact upstream version, compares it with the installed package, and
publishes `idle`, `checking`, or `update-available`; it never downloads a DMG,
builds a package, or validates a candidate during startup or `check-now`.

The renderer's visible **Update** action starts the only preparation path,
`factory-update-manager update --pid PID`. That desktop-user operation performs
the exact-version download, isolated build, and package validation, publishing
`downloading`, `building`, and `validating` before `ready-to-install`.
Authentication is intentionally deferred until preparation has succeeded.
Polkit then authorizes installation, and the package manager must verify the
exact expected version. The updater controls one bounded Factory exit,
installation or known-good rollback, and automatic relaunch through the fixed
`/opt/Factory/factory-desktop-launcher` path. The relaunch occurs once only for
verified `installed` or `rolled-back` outcomes. No manual restart is required,
although one process restart remains technically necessary for new Electron
code to load; the updater performs it automatically.

The externally published Linux states are `idle`, `checking`,
`update-available`, `downloading`, `building`, `validating`, `ready-to-install`,
`installing`, `installed`, `install-failed-manual-action`, `rolled-back`, and
`failed`. A crashed or stale active operation must resolve to a terminal
failure/manual-action outcome with bounded diagnostics, never an eternal active
spinner. AppImage remains explicitly updater-unavailable because it has no
native helper, polkit policy, updater daemon, or privileged self-update path.

## Non-Negotiable Invariants

- Required patches are fail-closed.
- Patch reports are evidence, not a success marker: validators must prove the
  expected behavior.
- Builds happen in a sibling candidate directory and are promoted only after
  acceptance passes.
- Update-builder dependencies are installed inside the staged builder; CI
  `node_modules` are never copied as-is.
- No package may contain an absolute symlink to a build workspace or a binary
  without its executable bit.
- The Droid daemon is adopted by health at `127.0.0.1:37643`; exact cmdline
  matching is not an adoption criterion.
- The daemon health wait budget is at least 15 seconds.

## Runtime Identity

The Linux app and the user-owned Droid service will share the current resolved
`droid` executable. The resolver must re-check the executable and supported
daemon flags after Droid self-updates; it must not cache a path or version for
the lifetime of the installation.

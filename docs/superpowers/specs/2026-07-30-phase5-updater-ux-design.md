# Phase 5 Updater UX Design

## Goal

Complete the native-package update experience from a validated candidate through
controlled application exit, verified installation or rollback, one relaunch,
and actionable user-visible outcomes. AppImage remains explicitly
`update-manager-unavailable`.

## Trust Boundaries

The remote renderer receives no generic process execution API. A package-owned
`/usr/lib/factory-desktop/update-bridge.cjs` is loaded once by a minimal ASAR
patch and replaces only the known `updates:getState`, `updates:install`, and
`updates:checkNow` IPC handlers. The bridge accepts a fixed action whitelist and
validated payloads, invokes only `/usr/bin/factory-update-manager`, applies
bounded timeouts, validates the status envelope, bounds and sanitizes displayed
text, and maps exact Rust state to the renderer's existing `kind` contract plus
`linuxState`. Contract drift rejects the package build.

Native Electron dialogs, always parented to a live Factory `BrowserWindow`,
provide install/restart confirmation, copy-manual-command, retry-after-failure,
and dismiss. Dialogs appear only after an explicit action or once per relevant
state transition. Dismissal records presentation state only; it never deletes or
mutates a validated candidate. Copy uses Electron clipboard and never executes
the copied command.

## State And Commands

Persisted state becomes schema 2 and migrates schema 1 with defaults. New fields
are `manual_command`, `notification_dedupe_key`, `install_requested`,
`approval_id`, `approval_expires_at`, `relaunch_pending`, and `relaunch_error`.
The external status envelope remains `schemaVersion: 1`; it exposes a sanitized
compatibility view with `kind`, `linuxState`, candidate version/hash/path,
`manualCommand`, and relaunch/approval data.

`prepare-install` marks the accepted candidate requested and spawns one detached
`after-exit` process. The after-exit process holds its own lock, waits a bounded
time until the Factory product binary is gone, calls `install-ready`, reloads and
verifies state, and launches the fixed product launcher exactly once only for
`Installed` or `RolledBack`. Manual action and failure never produce an install
or relaunch loop. Relaunch failure preserves the verified terminal state and
records an actionable error. `reconcile-install` queries the package manager and
converts a preserved manual-action candidate to `Installed` only when its exact
expected version is installed.

## Notifications

Notification delivery is abstracted for tests and uses `notify-send` with a
portal-oriented fallback when available. Ready, manual action, installed,
rolled-back, and rejected events have deterministic dedupe keys persisted in
state. Repeated daemon intervals do not redisplay the same event for the same
candidate. Notification failures do not change update acceptance or installation
state.

## Approval Architecture

`unattended = true` is explicit configuration, but does not bypass authentication
in Phase 5. An authenticated root approval command reloads the user request,
re-inspects the package, verifies package name/version/format/hash and accepted
patch-report hash, copies the package into a root-owned cache, and writes a
root-owned approval record. Approval IDs use a strict non-path grammar. Records
contain schema version, package identity, format, SHA-256, root-cache path, patch
report hash, creation and expiry timestamps. Parents are mode 0700 and records
0600; root ownership and canonical path confinement are mandatory. Symlinks,
traversal, metadata drift, version mismatch, hash mismatch, expiry, and replay
fail closed.

`install-approved-package <approval-id>` accepts no manifest or arbitrary path.
It atomically renames the approval into a consumed area before package-manager
invocation, then repeats record, ownership, path, package, hash, and inspection
checks. A consumed approval cannot be replayed. The polkit action remains
`allow_active=no`; normal production installation remains `auth_admin_keep` or
manual fallback until a separate privileged live E2E verdict permits policy
activation.

## Packaging And Verification

Deb and RPM packages install the bridge at the fixed path, owned by root and not
user-writable. Package inspection proves its path/mode and exact absence from
AppImage. ASAR validation proves one bridge load and all three required handler
replacements. Tests use fake process, package-manager, notification, and bridge
backends; no unit test performs a real package install. Live Mint smoke installs
only a newly built 0.139.0 package after automated gates and does not perform a
downgrade or rollback without separate confirmation.

# Linux Update Manager

The native update manager is `factory-update-manager`, built from `updater/` and
installed only by native `.deb`/`.rpm` packages. AppImage does not install or
expect a native helper: its launcher exports
`FACTORY_UPDATE_MANAGER_UNAVAILABLE` and the ASAR bridge reports
`update-manager-unavailable` without attempting to load
`/usr/lib/factory-desktop/update-bridge.cjs`.

## Lifecycle

The updater deliberately separates inexpensive metadata checks from the
user-authorized update operation:

1. The `systemd --user` `daemon` starts and checks upstream metadata. It
   compares the latest exact upstream version with the installed package and
   publishes `idle` or `update-available`. It does **not** download a DMG,
   build a package, or validate an artifact.
2. `check-now` performs the same metadata-only check immediately. Repeated
   daemon checks and startup checks are safe and do not create candidates.
3. Clicking **Update** in Factory starts `factory-update-manager update --pid
   PID`. This is the only operation that may prepare a candidate. Running as
   the desktop user, it downloads the exact upstream DMG, builds in an
   isolated candidate workspace, and validates the resulting package.
4. After preparation succeeds, the state becomes `ready-to-install`. Only
   then does the updater request authentication through polkit and begin
   installation. The package manager verifies the installed version before
   the operation is considered successful.
5. The bridge initiates one controlled Electron relaunch/quit after the updater
   waits for the Factory process tree, installs or rolls back, and verifies the
   package-manager result. The fixed `/opt/Factory/factory-desktop-launcher`
   identity is enforced for the relaunch. It occurs exactly once after a
   verified `installed` or `rolled-back` result. No manual restart is required.
   One process restart is still required internally for newly installed
   Electron code to load; the bridge/updater performs it automatically.

The default metadata-check interval is 21,600 seconds (six hours). It can be
configured in `~/.config/factory-update-manager/config.toml`:

```toml
check_interval_seconds = 21600
```

Values below 60 seconds are rejected to prevent a tight retry loop. Metadata,
network, build, and installation failures become terminal state with bounded
diagnostics; the daemon does not repeatedly install or relaunch. The
compatibility command `service` runs the same metadata-check loop.

Transient startup metadata failures are retried by the in-app bridge with bounded backoff before an error dialog is shown. A manual retry remains available after those attempts are exhausted.

## States

The external Linux state names are stable and lowercase:

| State | Meaning |
| --- | --- |
| `idle` | No newer accepted upstream version is available and no operation is active. |
| `checking` | Upstream metadata and the installed package version are being compared. |
| `update-available` | Metadata found a newer upstream version; no package has been downloaded. |
| `downloading` | The user-triggered operation is acquiring the exact DMG. |
| `building` | The isolated Node build pipeline is producing the candidate package. |
| `validating` | Package inspection, hashes, and acceptance checks are running. |
| `ready-to-install` | A validated candidate is retained and awaits the authenticated install step; cancelling polkit returns here so retrying does not download or rebuild the candidate. |
| `installing` | Polkit-authenticated package installation or verified rollback is running. |
| `installed` | The expected package version is installed and verified. |
| `install-failed-manual-action` | A privileged command failed after authentication, or recovery needs an explicit operator action. |
| `rolled-back` | Installation failed, but one known-good package was restored and verified. |
| `failed` | Metadata, download, build, validation, or other non-install operation failed. |

An active operation that crashes or becomes stale is recovered to a terminal
failure/manual-action state with an error, rather than leaving an eternal
`downloading`, `building`, `validating`, or `installing` spinner. Retained
candidate files are not discarded until the terminal outcome or an explicit
discard permits cleanup.

## Candidate and Process Safety

`daemon` and `check-now` run as the desktop user and are metadata-only. The
user-triggered `update --pid PID` operation uses a shared lock so only one
download/build/validation can run. A separate install/after-exit lock blocks
duplicate install requests. State is stored under
`~/.local/state/factory-update-manager/state.json`; candidate DMGs are stored in
`~/.cache/factory-update-manager/downloads`; and build workspaces are under
`~/.cache/factory-update-manager/workspaces/<candidate-id>`.

The existing Node pipeline remains the build source of truth. A candidate is
accepted only after `scripts/inspect-package.js` accepts it and Rust records
its own SHA-256 in `validated-candidate.json`. The candidate workspace,
manifest, and package are retained through `ready-to-install`, `installing`,
and manual-action states. Cleanup occurs only after `installed`,
`rolled-back`, `failed`, explicit discard, or replacement by a newly accepted
candidate.

The package-owned Electron bridge lives at the fixed path
`/usr/lib/factory-desktop/update-bridge.cjs`, mode `0644`, in deb/rpm packages.
The fail-closed ASAR patch replaces only `updates:getState`, `updates:install`,
and `updates:checkNow`, then publishes validated state through the existing
`updates:state` channel. The bridge has bounded helper timeouts, no path
override, no generic execution API, and accepts only empty payloads for its
three whitelisted actions.

`updates:install` starts the user-triggered operation from
`update-available` or `ready-to-install`; it does not quit Factory immediately.
The controlled exit occurs only after preparation is complete and the
operation is ready for authenticated installation. Manual-action and failed
states never enter an install/relaunch loop. `reconcile-install` is available
after an authenticated terminal fallback and records `installed` only when
the installed version exactly equals the expected candidate version.

## Privilege Boundary

The ordinary install step performs one privileged request through polkit after
download, build, and validation. Defaults require `auth_admin_keep` for
`install-deb` or `install-rpm`. If polkit is unavailable or denied, state
becomes `install-failed-manual-action` with a separate updater-generated
`manualCommand`. The renderer may display or copy that command but cannot
execute it, and no passwordless retry loop is attempted.

The opt-in approval architecture is separate from the normal update click.
Unattended approval preparation is off by default and can only be enabled
through `setup-unattended --acknowledge-authentication-required` (or an
equivalent explicit `unattended = true` config). A user-owned approval request
is not authorization. The authenticated `approve-candidate` root helper
re-runs package inspection, copies the package with `O_NOFOLLOW` into the
root-owned `/var/cache/factory-update-manager/packages` cache, and creates a
mode `0600` record under a mode `0700` root-owned hierarchy. The record binds a
strict 64-lowercase-hex approval ID to package name, version, format, package
SHA-256, accepted patch-report SHA-256, confined root-cache path, creation
time, and expiry.

`install-approved-package <approval-id>` accepts an approval ID, never a
manifest or arbitrary path. It rechecks ownership, modes, confinement,
metadata, both hashes, expiry, and strict version upgrade, then atomically
moves the record to `consumed/` before invoking the package manager. Replay,
symlink, path traversal, metadata drift, hash drift, expiry, or version
mismatch fail closed. Its polkit action deliberately remains `allow_active=no`
pending a separate privileged live E2E review. Therefore `unattended = true`
does not bypass authentication, and fully unattended updates are not enabled
or claimed.

The privileged helper reloads the candidate manifest, copies the package into
`/var/cache/factory-update-manager/packages`, re-hashes it, runs the package
inspector again, then invokes `dpkg -i` or `rpm -Uvh --replacepkgs`. On success
it retains up to two known-good packages under
`/var/lib/factory-update-manager/known-good`. On install failure it attempts
one known-good rollback; if rollback is unavailable or fails, it reports
manual action. Both installation and rollback require an exact package-manager
version query.

## Commands
```bash
factory-update-manager daemon
factory-update-manager check-now
factory-update-manager update --pid PID
factory-update-manager status --json
factory-update-manager diagnose
factory-update-manager reconcile-install
factory-update-manager setup-unattended --acknowledge-authentication-required
sudo factory-update-manager rollback
sudo factory-update-manager approve-candidate /absolute/path/approval-request.json
sudo factory-update-manager install-approved-package APPROVAL_ID
```

`check-now` is metadata-only. Do not use it as a download, build, package, or
validation command. `update --pid PID` is the only supported preparation path;
the bridge invokes it after the user clicks Update. There is no supported
manual-restart step between a successful install and the automatic relaunch.

The persisted state schema is version 2 and migrates schema-1 records with safe
defaults. `status --json` deliberately keeps the external
`schemaVersion: 1`: the exact Linux state is in `linuxState`, renderer
compatibility is in `kind`, and candidate path/hash/version, `manualCommand`,
approval metadata, and relaunch status are separate fields. Plain `status`
returns the same JSON for compatibility.

## AppImage

AppImage intentionally reports `update-manager-unavailable`. It has no native
helper, polkit policy, updater daemon, privileged self-update, or automatic
native relaunch path. Users of the AppImage must obtain and launch a newer
AppImage separately.

## Build Verification

```bash
make check
make test
make package-smoke VERSION=0.139.0 DIST_DIR=/tmp/factory-phase5-smoke
```

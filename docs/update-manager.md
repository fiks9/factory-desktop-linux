# Rust Update Manager MVP

The native update manager is `factory-update-manager`, built from `updater/` and
installed only by native `.deb`/`.rpm` packages. AppImage does not install or
expect a native helper; its launcher exports `FACTORY_UPDATE_MANAGER_UNAVAILABLE`
and the ASAR bridge returns `update-manager-unavailable` without attempting to
load `/usr/lib/factory-desktop/update-bridge.cjs`.

## Lifecycle

`daemon` is a long-running `systemd --user` process. On startup it recovers an
interrupted `Installing` state as `InstallFailedManualAction`, performs one
immediate check, and then checks on a fixed interval. The default interval is
21,600 seconds (six hours). It can be configured in
`~/.config/factory-update-manager/config.toml`:

```toml
check_interval_seconds = 21600
```

Values below 60 seconds are rejected to prevent a tight retry loop. Network or
build failures are retried only at the next planned interval. The compatibility
command `service` runs the same daemon loop.

`check-now`, `rebuild`, and the daemon run as the desktop user. A shared lock
serializes check/build work, while a separate daemon lock prevents two daemon
instances. The updater writes state under
`~/.local/state/factory-update-manager/state.json`, downloads or copies the DMG
into `~/.cache/factory-update-manager/downloads`, builds inside
`~/.cache/factory-update-manager/workspaces/<candidate-id>`, and calls the
existing Node pipeline as the single source of truth. The Rust wrapper accepts a
candidate only after `scripts/inspect-package.js` accepts the package and Rust
records its own SHA-256 in `validated-candidate.json`.

Accepted candidates move to `ReadyPendingExit` and are not installed while
Factory Desktop is running. `ReadyPendingExit`, `Installing`, and
`InstallFailedManualAction` block new builds and retain the candidate workspace,
manifest, and package. Cleanup removes it only after `Installed`, `RolledBack`,
an explicit discard, or replacement by a newly accepted candidate.

The package-owned Electron bridge lives at the fixed path
`/usr/lib/factory-desktop/update-bridge.cjs`, mode `0644`, in deb/rpm packages.
The fail-closed ASAR patch replaces only `updates:getState`, `updates:install`,
and `updates:checkNow`, then publishes validated state through the existing
`updates:state` channel. The bridge has bounded helper timeouts, no path
override, no generic execution API, and only accepts empty payloads for its
three whitelisted actions.

`prepare-install` records one install request and starts one detached
after-exit helper. Its separate lock blocks duplicates. The helper waits up to
120 seconds for the Factory process tree to exit, calls `install-ready`, and
relaunches `/opt/Factory/factory-desktop-launcher` exactly once only after the
package manager has verified `Installed` or `RolledBack`. Manual action and
failed states do not enter an install/relaunch loop. `reconcile-install` queries
the native package manager after a manual install and only records `Installed`
when the installed version equals the expected candidate version.

## Privilege Boundary

`install-ready` performs one privileged request through polkit. Defaults require
`auth_admin_keep` for `install-deb` or `install-rpm`. Unattended approval
preparation is off by default and can only be enabled through
`setup-unattended --acknowledge-authentication-required` (or an equivalent
explicit `unattended = true` config). The ordinary install action remains
format-specific and authenticated even when this option is enabled.
If polkit is unavailable or denied, state becomes `InstallFailedManualAction`
with a separate updater-generated `manualCommand`. The renderer may copy that
command but cannot execute it. There is no retry loop.

When opt-in is enabled, candidate acceptance writes an approval request next to
the validated manifest. That user-owned request is not an approval. The
authenticated `approve-candidate` root helper re-runs package inspection, copies
the package with `O_NOFOLLOW` into the root-owned
`/var/cache/factory-update-manager/packages` cache, and creates a mode `0600`
record under a mode `0700` root-owned hierarchy. The record binds a strict
64-lowercase-hex approval ID to package name, version, format, package SHA-256,
accepted patch-report SHA-256, confined root-cache path, creation time, and
expiry.

`install-approved-package <approval-id>` accepts an approval ID, never a
manifest or arbitrary path. It rechecks ownership, modes, confinement,
metadata, both hashes, expiry, and strict version upgrade, then atomically moves
the record to `consumed/` before invoking the package manager. Replay, symlink,
path traversal, metadata drift, hash drift, expiry, or version mismatch fail
closed. Its polkit action deliberately remains `allow_active=no` pending a
separate privileged live E2E review. Therefore `unattended = true` does not
bypass authentication, and fully unattended updates are not enabled or claimed.

The privileged helper reloads the candidate manifest, copies the package into
`/var/cache/factory-update-manager/packages`, re-hashes it, runs the package
inspector again, then invokes `dpkg -i` or `rpm -Uvh --replacepkgs`. On success it
retains up to two known-good packages under
`/var/lib/factory-update-manager/known-good`. On install failure it attempts one
known-good rollback; if rollback is unavailable or fails, it reports manual
action.

## Commands

```bash
factory-update-manager daemon
factory-update-manager check-now
factory-update-manager rebuild --dmg /absolute/path/Factory.dmg --version 0.139.0 --format deb
factory-update-manager status --json
factory-update-manager diagnose
factory-update-manager prepare-install --pid PID
factory-update-manager install-ready
factory-update-manager reconcile-install
factory-update-manager setup-unattended --acknowledge-authentication-required
sudo factory-update-manager approve-candidate /absolute/path/approval-request.json
sudo factory-update-manager install-approved-package APPROVAL_ID
```

The persisted state schema is version 2 and migrates schema-1 records with safe
defaults. `status --json` deliberately keeps a stable external
`schemaVersion: 1`: exact state is in `linuxState`, renderer compatibility is in
`kind`, and candidate path/hash/version, `manualCommand`, approval metadata, and
relaunch status are separate fields. Plain `status` returns the same JSON for
compatibility.

Build verification:

```bash
make check
make test
make package-smoke VERSION=0.139.0 DIST_DIR=/tmp/factory-phase5-smoke
```

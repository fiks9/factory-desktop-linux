# Rust Update Manager MVP

The native update manager is `factory-update-manager`, built from `updater/` and
installed only by native `.deb`/`.rpm` packages. AppImage does not install or
expect a native helper; its launcher exports `FACTORY_UPDATE_MANAGER_UNAVAILABLE`
and points `FACTORY_UPDATE_MANAGER_PATH` at a non-existent private path.

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

## Privilege Boundary

`install-ready` performs one privileged request through polkit. Defaults require
`auth_admin_keep` for `install-deb` or `install-rpm`. Unattended installation is
off unless `~/.config/factory-update-manager/config.toml` contains exactly
`unattended = true`; that path uses the separate
`install-validated-package` action, whose policy default is `allow_active=no`.
If polkit is unavailable or denied, state becomes `InstallFailedManualAction`
with a terminal fallback command. There is no retry loop.

Setting `unattended = true` does not grant passwordless installation in Phase 4:
the `install-validated-package` action remains `allow_active=no`. Phase 5 must
add root-side approval and attestation before that action can be enabled. A
user-owned candidate manifest, package path, or SHA-256 is not sufficient
authorization for an unattended root installation.

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
factory-update-manager install-ready
```

`status --json` has a stable top-level `schemaVersion` of `1`. Its top-level
fields are `schemaVersion`, `state`, and `stateFile`; `state` is the persisted
state record. Plain `status` returns the same JSON for compatibility.

Build verification:

```bash
make check
make test
make package-smoke VERSION=0.139.0 DIST_DIR=/tmp/factory-phase4-smoke
```

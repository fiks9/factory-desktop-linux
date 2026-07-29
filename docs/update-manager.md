# Rust Update Manager MVP

The native update manager is `factory-update-manager`, built from `updater/` and
installed only by native `.deb`/`.rpm` packages. AppImage does not install or
expect a native helper; its launcher exports `FACTORY_UPDATE_MANAGER_UNAVAILABLE`
and points `FACTORY_UPDATE_MANAGER_PATH` at a non-existent private path.

## Lifecycle

`check-now` and `rebuild` run as the desktop user. They acquire a single-instance
lock, write state under `~/.local/state/factory-update-manager/state.json`,
download or copy the DMG into `~/.cache/factory-update-manager/downloads`, build
inside `~/.cache/factory-update-manager/workspaces/<candidate-id>`, and call the
existing Node pipeline as the single source of truth. The Rust wrapper accepts a
candidate only after `scripts/inspect-package.js` accepts the package and Rust
records its own SHA-256 in `validated-candidate.json`. Accepted candidates move
to `ReadyPendingExit` and are not installed while Factory Desktop is running.

## Privilege Boundary

`install-ready` performs one privileged request through polkit. Defaults require
`auth_admin_keep` for `install-deb` or `install-rpm`. Unattended installation is
off unless `~/.config/factory-update-manager/config.toml` contains exactly
`unattended = true`; that path uses the separate
`install-validated-package` action, whose policy default is `allow_active=no`.
If polkit is unavailable or denied, state becomes `InstallFailedManualAction`
with a terminal fallback command. There is no retry loop.

The privileged helper reloads the candidate manifest, copies the package into
`/var/cache/factory-update-manager/packages`, re-hashes it, runs the package
inspector again, then invokes `dpkg -i` or `rpm -Uvh --replacepkgs`. On success it
retains up to two known-good packages under
`/var/lib/factory-update-manager/known-good`. On install failure it attempts one
known-good rollback; if rollback is unavailable or fails, it reports manual
action.

## Commands

```bash
factory-update-manager check-now
factory-update-manager rebuild --dmg /absolute/path/Factory.dmg --version 0.139.0 --format deb
factory-update-manager status
factory-update-manager diagnose
factory-update-manager install-ready
```

Build verification:

```bash
make check
make test
make package-smoke VERSION=0.139.0 DIST_DIR=/tmp/factory-phase4-smoke
```

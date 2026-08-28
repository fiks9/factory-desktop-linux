# Maintainer Runbook

## Upstream And Pinned Builds

Check official metadata without credentials:

```bash
node scripts/upstream-watch.js
```

The watcher discovers a version through official metadata, then downloads that
exact version from the official `downloads.factory.ai` S3 bucket. Do not replace
the exact URL builder with the mutable latest-download redirect or hand-edit the
cache index. `release/accepted-upstream.json` is the sole accepted-version
authority. The automatic watcher uses GitHub release tags only to avoid
dispatching a duplicate release; tags, drafts, and prereleases do not advance
it. Only the successful `publish` job records a new accepted version in the
file. Host/path/version drift fails closed.

Build an authorized local DMG with an absolute path and exact version:

```bash
make build-app DMG=/absolute/path/Factory.dmg VERSION=0.139.0
```

The builder copies source into a content-addressed cache. Never modify the
original, and never add a DMG, extracted app, ASAR, or package to git.

## Blocking Commands

```bash
make check
make test
make package-smoke VERSION=0.139.0 DIST_DIR=/tmp/factory-package-smoke
make test-real-bundles
make release-check
```

Exercise an explicit wrapper revision before a corrected release:

```bash
make package-smoke VERSION=0.139.0 WRAPPER_REVISION=linux.1 DIST_DIR=/tmp/factory-package-smoke-linux.1
```

This must produce deb `0.139.0-1`, RPM `0.139.0-2`, and
`Factory-0.139.0-linux.1-x86_64.AppImage` while every inspection still reports
upstream Factory version `0.139.0`.

Build formats only from an accepted staged app:

```bash
make deb APP_DIR=/absolute/staged/app VERSION=0.139.0 DIST_DIR=/tmp/factory-dist
make rpm APP_DIR=/absolute/staged/app VERSION=0.139.0 DIST_DIR=/tmp/factory-dist
make appimage APP_DIR=/absolute/staged/app VERSION=0.139.0 DIST_DIR=/tmp/factory-dist
```

Inspect every result:

```bash
make inspect-package ARTIFACT=/tmp/factory-dist/factory-desktop_0.139.0_amd64.deb
make inspect-package ARTIFACT=/tmp/factory-dist/factory-desktop-0.139.0-1.x86_64.rpm
make inspect-package ARTIFACT=/tmp/factory-dist/Factory-0.139.0-x86_64.AppImage
```

`make release-check` runs source checks, Rust/Node tests, synthetic package
acceptance, the real local harness, provenance/checksum contracts, artifact
hygiene, and verifies that source-tree status is unchanged.

The upstream cache stores `Factory-<sha256>.dmg`; `version-index.json` is written
only after structural/version acceptance. Do not hand-edit this index.

## Final Regression Matrix

| Contract | Required verdict |
|---|---|
| synthetic Statsig transport | patch and validators pass |
| synthetic hardcoded IPC transport | patch and validators pass |
| raw Factory 0.139.0 | PASS when authorized local fixture is available |
| raw 0.137.0 fixture | explicit `SKIP (local fixture unavailable)` allowed; never fake PASS |
| raw 0.138.0 fixture | explicit `SKIP (local fixture unavailable)` allowed; never fake PASS |
| deb/rpm/AppImage | build, extraction, hygiene, inspection pass |
| package hygiene | no forbidden paths, links, or executable modes |
| whole-bundle JavaScript syntax | required `bundle-javascript-syntax` outcome plus staged and extracted parse-only checks |
| product-named ELF | `factory-desktop`, never `electron` |
| protocol MIME | `x-scheme-handler/factory-desktop` present |
| StartupWMClass | `Factory` present |
| keyring | `FACTORY_DISABLE_KEYRING=1` present |
| update bridge | fixed native path/mode; absent from AppImage |
| metadata-only checks | startup, daemon, and `check-now` never download/build/validate |
| user-triggered preparation | Update click invokes `update --pid PID`; states reach downloading/building/validating/ready-to-install |
| authenticated install | polkit is requested only after preparation; package-manager version is exact |
| controlled relaunch | one verified install/rollback, one automatic relaunch; no manual restart step |
| stale-operation recovery | crash/stale active state resolves to terminal failure/manual action, not an eternal spinner |
| approval security tests | traversal/hash/expiry/replay/ownership reject |
| rollback verification | package query equals known-good version |

## Debugging

- Patch drift: preserve `patch-report.json` and bounded `patch-drift.json`; follow
  [patch drift](patch-drift.md). A `bundle-javascript-syntax` failure means the
  complete patched CommonJS bundle did not parse; never package after it.
- Daemon adoption: run `curl --fail http://127.0.0.1:37643/health`, then
  `systemctl --user status factory-droid-daemon.service`. Remote access is not an
  adoption condition.
- Keyring/OAuth: confirm `FACTORY_DISABLE_KEYRING=1`, protocol MIME, and
  `xdg-mime query default x-scheme-handler/factory-desktop`.
- Protocol handler: validate the desktop file and run `update-desktop-database`.
- Updater metadata check: inspect `factory-update-manager status --json` and
  updater logs. `check-now` is metadata-only and must not create a candidate.
- Update operation: exercise the visible Update action or
  `factory-update-manager update --pid PID`; retain diagnostics for each state.
  Do not trigger installation by quitting Factory before `ready-to-install`.
- Polkit/manual fallback: inspect `factory-update-manager status --json`, copy
  updater-owned `manualCommand`, then run `reconcile-install` only after the
  authenticated command completes. Never execute arbitrary renderer paths.
- Updater daemon: inspect `systemctl --user status factory-update-manager.service`
  and `journalctl --user -u factory-update-manager.service`.

## Rollback

Inspect state and known-good metadata, then authenticate the documented rollback
command. Rollback succeeds only when the post-install package query returns the
exact known-good version; the updater then performs its one automatic relaunch.
Never live-test downgrade/rollback without backup and explicit operator approval.

```bash
sudo /usr/bin/factory-update-manager rollback
```

## Safe Cleanup

Resolve and inspect exact generated paths before moving them to trash:

```bash
gio trash -- /tmp/factory-package-smoke
gio trash -- /absolute/repo/dist
gio trash -- /absolute/repo/work
```

Do not remove updater workspaces referenced by `ready-to-install`, `installing`,
or `install-failed-manual-action`. Never target the repository root or broad
home and cache directories.

## Publish

After local green verdict, push the reviewed commit. The scheduled upstream
watcher will automatically dispatch the **Release** workflow for a newly
accepted Factory version, select the next unused `linux.N`, and publish only
after `build-and-accept` is green. Maintainers may still dispatch it manually
from the protected default branch with exact `factory_version`, explicit
`wrapper_revision`, and reviewed `source_ref`. Review `checksums.txt`,
`build-info.json`, `patch-report.json`, and `acceptance-summary.json` before
announcing the release.
The controlled relaunch uses the updater's bounded after-exit wait for Factory to exit before authenticated installation; this is automatic and is not a manual restart step.

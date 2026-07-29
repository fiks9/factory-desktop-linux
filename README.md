# Factory Desktop for Linux

An unofficial Linux wrapper and build toolchain for Factory Desktop.

This repository does not contain Factory Desktop, a macOS DMG, `app.asar`,
Factory assets, or a Droid binary. The build tooling operates on a copy of the
official macOS application obtained by the user through an authorized source.
Generated and proprietary-derived payloads are deliberately gitignored.

## Status

Phase 4 is in progress: deterministic DMG acquisition, Linux runtime staging,
fail-closed ASAR patching, package hygiene, `.deb`/`.rpm`/AppImage packaging,
and a native Rust update-manager MVP are in place. Native packages include the
updater and an isolated Node update-builder; AppImage remains portable and
reports the native updater as unavailable.

## Design Rules

- Required upstream patches fail the build when they do not match or validate.
- A candidate is never promoted before the acceptance profile passes.
- Generated proprietary payloads remain outside git and outside source paths.
- Native packages use a `systemd --user` updater; AppImage does not assume a
  system-installed updater helper exists.
- The default privileged update path requires a graphical polkit agent or
  reports an explicit terminal fallback. Unattended configuration is opt-in,
  but passwordless root installation remains disabled until Phase 5 adds
  root-side approval and attestation.

## Planned Formats

The native updater targets `.deb` and `.rpm` installations. AppImage builds are
portable and deliberately do not implement privileged native self-update.

## Planned Commands

```bash
make check
make test
make build-app DMG=/absolute/path/to/Factory.dmg
make deb
make updater
```

`make build-app` discovers the current version and downloads the official DMG.
For a deterministic local build use `make build-app DMG=/absolute/path/Factory.dmg VERSION=0.139.0`.
The `.deb` command requires `APP_DIR` and `VERSION`, for example
`make deb APP_DIR=work/candidate-123/app VERSION=0.139.0`.

`make build-app` runs the patch engine before staging the Linux runtime.
`make updater` builds the Rust helper used by native packages. See
`docs/update-manager.md` for the MVP update flow and privilege model.

## Legal Notice

This is an unofficial community project and is not affiliated with, endorsed
by, or supported by Factory. Factory Desktop, Factory trademarks, Factory
services, the official macOS application, its code, assets, and Droid remain
the property of their respective owners. Users are responsible for obtaining
and using authorized upstream software. This repository licenses only its
wrapper, tooling, Linux compatibility glue, tests, and documentation under
the MIT License.

See `docs/legal-and-artifact-policy.md` before publishing releases.

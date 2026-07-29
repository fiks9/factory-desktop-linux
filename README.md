# Factory Desktop for Linux

An unofficial Linux wrapper and build toolchain for Factory Desktop.

This repository does not contain Factory Desktop, a macOS DMG, `app.asar`,
Factory assets, or a Droid binary. The build tooling operates on a copy of the
official macOS application obtained by the user through an authorized source.
Generated and proprietary-derived payloads are deliberately gitignored.

## Status

Phase 1 is complete: deterministic DMG acquisition, pinned-DMG mode, content-
addressed caching, DMG acceptance/extraction, Linux Electron runtime staging,
and a base `.deb` builder are in place. ASAR patching and the updater remain
fail-closed placeholders for Phases 2 and 4.

## Design Rules

- Required upstream patches fail the build when they do not match or validate.
- A candidate is never promoted before the acceptance profile passes.
- Generated proprietary payloads remain outside git and outside source paths.
- Native packages use a `systemd --user` updater; AppImage does not assume a
  system-installed updater helper exists.
- The default privileged update path requires a graphical polkit agent or
  reports an explicit terminal fallback. Passwordless unattended installation
  is opt-in and separately validated.

## Planned Formats

The MVP targets Debian packages. RPM and AppImage packaging follow after the
deterministic build, patch, and package-hygiene gates are established.

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

The build commands for ASAR patching and the updater remain intentionally
fail-closed until their respective phases are implemented.

## Legal Notice

This is an unofficial community project and is not affiliated with, endorsed
by, or supported by Factory. Factory Desktop, Factory trademarks, Factory
services, the official macOS application, its code, assets, and Droid remain
the property of their respective owners. Users are responsible for obtaining
and using authorized upstream software. This repository licenses only its
wrapper, tooling, Linux compatibility glue, tests, and documentation under
the MIT License.

See `docs/legal-and-artifact-policy.md` before publishing releases.

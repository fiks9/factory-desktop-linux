# Factory Desktop for Linux

An unofficial Linux wrapper and build toolchain for Factory Desktop.

This repository does not contain Factory Desktop, a macOS DMG, `app.asar`,
Factory assets, or a Droid binary. The build tooling operates on a copy of the
official macOS application obtained by the user through an authorized source.
Generated and proprietary-derived payloads are deliberately gitignored.

## Status

Phase 0 is complete: repository contracts, legal hygiene, build entry points,
and CI scaffolding are in place. Application assembly, ASAR patching, package
builders, and the Rust update manager are added in later phases only after they
have tests and fail-closed validation.

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

The build commands are intentionally placeholders in Phase 0 and fail with a
clear message until their phase is implemented.

## Legal Notice

This is an unofficial community project and is not affiliated with, endorsed
by, or supported by Factory. Factory Desktop, Factory trademarks, Factory
services, the official macOS application, its code, assets, and Droid remain
the property of their respective owners. Users are responsible for obtaining
and using authorized upstream software. This repository licenses only its
wrapper, tooling, Linux compatibility glue, tests, and documentation under
the MIT License.

See `docs/legal-and-artifact-policy.md` before publishing releases.

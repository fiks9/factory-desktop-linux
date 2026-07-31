# Factory Desktop for Linux

[![CI](https://github.com/fiks9/factory-desktop-linux/actions/workflows/ci.yml/badge.svg)](https://github.com/fiks9/factory-desktop-linux/actions/workflows/ci.yml)
[![Package Smoke](https://github.com/fiks9/factory-desktop-linux/actions/workflows/package-smoke.yml/badge.svg)](https://github.com/fiks9/factory-desktop-linux/actions/workflows/package-smoke.yml)
[![Release](https://github.com/fiks9/factory-desktop-linux/actions/workflows/release.yml/badge.svg)](https://github.com/fiks9/factory-desktop-linux/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/github/license/fiks9/factory-desktop-linux)](LICENSE)

An unofficial Linux port and build toolchain for Factory Desktop. It converts an
authorized copy of the official macOS application into Linux packages while
keeping Factory's proprietary payload outside the source repository.

> [!IMPORTANT]
> This project is not affiliated with, endorsed by, or supported by Factory.
> It does not redistribute Factory Desktop, its DMG, `app.asar`, assets, or the
> Droid binary.

[Install](#install) · [Features](#features) · [Architecture](#architecture) ·
[Updates](#updates) · [Build](#build-from-source) ·
[Troubleshooting](#troubleshooting) · [Documentation](#documentation)

## Packages

Accepted builds are published through
[GitHub Releases](https://github.com/fiks9/factory-desktop-linux/releases).
The repository produces these x86_64 formats:

| Format | Installation | Native update manager |
| --- | --- | --- |
| `.deb` | Debian package tools | Included |
| `.rpm` | RPM package tools | Included |
| AppImage | Portable executable | Not included |

The project does not publish a supported distribution matrix. Review your
package manager's output and the release acceptance metadata before installing.

## Install

Download the package for your system from the
[latest release](https://github.com/fiks9/factory-desktop-linux/releases/latest).
Each release includes `checksums.txt`, `build-info.json`, `patch-report.json`,
and `acceptance-summary.json` alongside the packages.

Verify downloaded files against the release checksum manifest:

```bash
sha256sum --check --ignore-missing checksums.txt
```

Install a native package with the appropriate system package manager:

```bash
# Debian package
sudo apt install ./factory-desktop_<version>_amd64.deb

# RPM package
sudo rpm -Uvh ./factory-desktop-<version>.x86_64.rpm
```

Run an AppImage without a system install:

```bash
chmod +x Factory-*-x86_64.AppImage
./Factory-*-x86_64.AppImage
```

AppImage is portable and does not include the privileged native updater,
polkit policy, or `systemd` user services.

## Features

- Deterministic, exact-version DMG acquisition with content-addressed caching.
- Fail-closed ASAR patching. Required patches and post-patch validators must all
  pass before a candidate can be packaged.
- Linux Electron runtime staging with desktop integration, protocol registration,
  and a product-named executable.
- Package hygiene checks for staged and extracted `.deb`, `.rpm`, and AppImage
  artifacts.
- A Rust update manager for native packages with after-exit installation,
  package-manager verification, known-good retention, and rollback support.
- Package-bound provenance, checksums, bounded diagnostics, and a manual release
  acceptance workflow.

## Architecture

The build pipeline keeps source, generated candidates, and privileged
installation responsibilities separate:

```text
authorized Factory DMG
        |
        v
exact-version acquisition and structural acceptance
        |
        v
fail-closed ASAR patching and JavaScript validation
        |
        v
Linux Electron runtime staging
        |
        v
package build, extraction, hygiene, and provenance checks
        |
        v
.deb / .rpm / AppImage
```

| Area | Responsibility |
| --- | --- |
| `patcher/` | Patch contracts, transforms, reports, and validators |
| `scripts/` | Acquisition, staging, packaging, inspection, and release gates |
| `launcher/` | Linux runtime environment and process launch |
| `packaging/` | Native package and AppImage integration files |
| `updater/` | Rust state machine, candidate validation, install, and rollback |
| `release/` | Accepted upstream version authority |
| `tests/` | Synthetic contracts, package acceptance, and local bundle regression |

Candidates are built in sibling workspaces and promoted only after the
acceptance profile passes. See [Architecture](docs/architecture.md),
[Patching](docs/patching.md), and
[Build and packaging](docs/build-and-packaging.md) for the detailed contracts.

## Updates

Native `.deb` and `.rpm` packages install `factory-update-manager` and a
`systemd --user` service. The manager checks on a six-hour default interval,
builds candidates as the desktop user, accepts them only after package
inspection, and waits for Factory Desktop to exit before requesting
installation. Successful install and rollback states require an exact
package-manager version query.

The normal privileged path requires polkit authentication. If polkit is
unavailable or denied, the updater records an explicit terminal command for the
user to run manually. The unattended approval architecture exists as an
explicit opt-in, but passwordless installation is not active:

- `install-approved-package` remains `allow_active=no`.
- `unattended = true` prepares approval requests but does not bypass
  authentication.
- Fully unattended updates are neither enabled nor claimed.
- AppImage does not have a privileged native updater.

Read [Update manager](docs/update-manager.md) for the state machine, commands,
and privilege boundary.

## Security model

The pipeline treats upstream metadata, package contents, renderer input, caches,
and package-manager results as untrusted until they pass their corresponding
checks. The main boundaries are:

- exact-version downloads are restricted to the documented Factory HTTPS
  host and path contract;
- DMGs become accepted only after structure, version, and hash validation;
- complete patched JavaScript bundles are parsed again at patch, staging, and
  extracted-package boundaries;
- native install approvals bind root-owned records to package identity, hashes,
  expiry, ownership, and confined paths;
- CI build jobs have read-only repository permissions, and only the final
  release publication job receives `contents: write`;
- proprietary DMGs, ASARs, extracted apps, screenshots, and generated packages
  remain outside git.

The full trust and privilege model is documented in
[Security model](docs/security-model.md) and
[Legal and artifact policy](docs/legal-and-artifact-policy.md).

## Build from source

Clone the wrapper and install the Node.js, Rust, Electron packaging, and native
package tools required by the workflows. The CI definitions use Node.js 22,
the stable Rust toolchain, 7-Zip, `cpio`, `rpm`, `squashfs-tools`, and
`desktop-file-utils`.

```bash
git clone https://github.com/fiks9/factory-desktop-linux.git
cd factory-desktop-linux

make check
make test
make build-app DMG=/absolute/path/to/Factory.dmg VERSION=0.139.0
```

`make build-app` can also discover the current version and acquire the official
DMG. A pinned build copies the authorized local DMG into the content-addressed
cache and never modifies the original.

Build packages from an accepted staged app:

```bash
make deb APP_DIR=work/latest/app VERSION=0.139.0 DIST_DIR=dist
make rpm APP_DIR=work/latest/app VERSION=0.139.0 DIST_DIR=dist
make appimage APP_DIR=work/latest/app VERSION=0.139.0 DIST_DIR=dist
```

Generated packages, downloads, caches, extracted payloads, `node_modules`, and
Rust target directories are ignored and must not be committed. See
[Build and packaging](docs/build-and-packaging.md) for acceptance and hygiene
details.

## Maintainer and release workflow

Run the blocking local checks before preparing a release:

```bash
make check
make test
make package-smoke VERSION=0.139.0 DIST_DIR=/tmp/factory-package-smoke
make test-real-bundles
make release-check
```

GitHub Releases are created only through the manually dispatched
[Release workflow](https://github.com/fiks9/factory-desktop-linux/actions/workflows/release.yml).
Maintainers provide an exact Factory version, an explicit `linux.N` wrapper
revision, and a reviewed source ref from the protected branch history. The
workflow builds and accepts the complete bundle before its separate publication
job can create a release.

The scheduled upstream watcher reports drift but does not change
`release/accepted-upstream.json`, create a release, or treat tags and drafts as
accepted upstream evidence. Default releases are checksum-only unless detached
`.asc` signatures are actually present.

See the [Maintainer runbook](docs/maintainer-runbook.md) and
[Release process](docs/release-process.md) before publishing.

## Troubleshooting

| Problem | First check |
| --- | --- |
| Version mismatch | Compare the requested version, DMG metadata, and accepted version. Do not override the mismatch. |
| Patch or JavaScript syntax failure | Preserve the bounded diagnostics and follow the [patch drift guide](docs/patch-drift.md). Do not package the candidate. |
| App starts in development mode | Confirm the installed ELF is `/opt/Factory/factory-desktop`, not `electron`. |
| OAuth or protocol callback fails | Check `FACTORY_DISABLE_KEYRING=1` and the `factory-desktop://` MIME handler. |
| Update UI is unavailable | Native packages require the fixed helper and bridge. AppImage reports the updater as unavailable by design. |
| Install needs manual action | Use the updater-owned `manualCommand`, then run `reconcile-install` after installation. |

More diagnostics and recovery steps are in
[Troubleshooting](docs/troubleshooting.md).

## Known limitations

- This is an unofficial compatibility port built from an authorized upstream
  macOS application, not a native Factory release for Linux.
- Upstream application changes can cause patch drift. Required patch failures
  stop the build instead of producing a partially patched package.
- AppImage does not include native update services or privileged self-update.
- Passwordless installation and fully unattended updates remain disabled
  pending a separate privileged live end-to-end verdict.
- The repository does not claim support for specific Linux distributions or
  Factory versions beyond artifacts that have passed the release workflow.
- Releases are checksum-only unless their assets include detached signatures.

## Roadmap

The implemented roadmap covers deterministic acquisition, fail-closed patching,
all three package formats, the Rust updater lifecycle, in-app update integration,
and manual release acceptance. Remaining security-sensitive work, including any
future passwordless update policy, requires a separate privileged live
end-to-end review. See [Roadmap](docs/roadmap.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Build and packaging](docs/build-and-packaging.md)
- [Patching](docs/patching.md)
- [Update manager](docs/update-manager.md)
- [Security model](docs/security-model.md)
- [Release process](docs/release-process.md)
- [Maintainer runbook](docs/maintainer-runbook.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Roadmap](docs/roadmap.md)
- [Legal and artifact policy](docs/legal-and-artifact-policy.md)

## License and disclaimer

This repository's original wrapper, tooling, Linux compatibility code, tests,
and documentation are available under the [MIT License](LICENSE). The license
does not grant rights to Factory Desktop, Factory services, trademarks, upstream
application code, assets, or Droid.

Users are responsible for obtaining and using authorized upstream software.
Use of Factory Desktop and Factory services remains subject to Factory's terms
and server-side availability.

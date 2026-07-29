# Phase 1 Build And Packaging

## Upstream Endpoints

The live version endpoint was verified on 2026-07-29:

```text
GET https://api.factory.ai/api/desktop/latest-version
200 application/json
{"latestVersion":"0.139.0"}
```

The DMG download endpoint is:

```text
https://app.factory.ai/api/desktop?platform=darwin&architecture=x64
```

It redirects to a short-lived, versioned download URL. The builder follows
redirects, checks the discovered version against the redirect version, streams
the body once, computes SHA-256, fsyncs the file, and publishes it as:

```text
downloads/Factory-<sha256>.dmg
```

Use `DMG=/absolute/path/Factory.dmg` for pinned local builds. A pinned DMG is
copied into the same content-addressed cache and is never modified.

## Commands

```bash
make build-app
make build-app DMG=/absolute/path/Factory.dmg VERSION=0.139.0
make smoke-dmg DMG=/absolute/path/Factory.dmg VERSION=0.139.0
make deb APP_DIR=work/candidate-123/app VERSION=0.139.0
```

Phase 1 builds an unpatched app. The runtime assembly accepts
`patchedAsarPath` as an explicit hook, so Phase 2 can run the required patch
engine before the Linux Electron runtime is staged. Phase 1 records whether
the hook was external in `build-info.json`; it does not pretend the source
ASAR was patched.

## Acceptance Profile v1

Before extraction, the DMG must contain a Factory `.app`, its `Contents/Info.plist`,
and `Contents/Resources/app.asar`. The app version is read from
`CFBundleShortVersionString`; the Electron version is read from the Electron
Framework `Info.plist`. Missing metadata is a hard failure. If `VERSION` or a
content hash was supplied, mismatches are hard failures.

The base `.deb` contains no updater. Its post-install script applies root
ownership and mode `4755` to `chrome-sandbox`, refreshes desktop metadata, and
registers `factory-desktop://` where an active user session is available.

The desktop entry includes `FACTORY_DISABLE_KEYRING=1`,
`MimeType=x-scheme-handler/factory-desktop;`, and `StartupWMClass=Factory`.

## Product Binary Name

The Linux Electron ELF must be named `factory-desktop`, not `electron`.
Electron uses the executable identity as part of its packaged-app detection;
leaving the runtime named `electron` makes `app.isPackaged` false even inside
`/opt/Factory`. That selects Factory's development paths, including `droid-dev`,
daemon `--debug` arguments, and development protocol naming.

Runtime staging therefore produces this layout:

```text
/opt/Factory/factory-desktop          # renamed Electron ELF
/opt/Factory/factory-desktop-launcher # environment shim
/opt/Factory/resources/app.asar
```

The shim executes the product-named ELF directly, so the final process keeps
the product identity. The production desktop entry invokes the shim and
registers only `factory-desktop://`; it does not register a `-dev` scheme.

## Package Hygiene

Every staged tree and every extracted package is scanned before acceptance.
The blocking scanner rejects absolute or workspace symlinks, broken or
absolute `node_modules/.bin` links, non-executable bin targets, non-executable
native ELF tools, and non-executable `7zip-bin/**/7za` payloads. Update-builder
staging copies only source manifests plus `src`/`dist`, runs
`npm ci --omit=dev`, and scans the resulting isolated tree.

Native `.deb` and `.rpm` packages include the Droid user service and secure
polkit policy, the Rust update-manager binary, a user recovery service, and an
isolated update-builder tree under `/usr/lib/factory-desktop/update-builder`.
Portable AppImage omits native services, policy, and updater binary; its AppRun
exports an unavailable updater path and supports the optional
`--install-desktop-integration` command.

Real DMG smoke builds are local-only in Phase 1. Proprietary DMGs and extracted
payloads must remain outside git and outside public CI artifacts.

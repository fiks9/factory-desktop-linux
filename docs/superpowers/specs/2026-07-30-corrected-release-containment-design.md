# Corrected Release Containment Design

## Scope

This change contains the broken `v0.139.0` release, fixes the updater bridge
injection, adds a mandatory parse-only JavaScript gate, and publishes a
corrected wrapper revision for upstream Factory `0.139.0`. It does not change
the upstream Factory version, enable passwordless installation, or weaken any
patch, hygiene, provenance, package inspection, or polkit gate.

## Release Containment

The broken GitHub Release is converted to a draft. Its tag, assets, checksums,
workflow run, title history, and original notes remain available for audit.
Normal users cannot download the broken package assets. Upstream Watch treats
`release/accepted-upstream.json` as the accepted-version authority and does not
derive acceptance from draft, prerelease, or wrapper release tags.

## Wrapper Revision Model

Factory version and wrapper revision are separate values:

| Identity | Corrected value |
| --- | --- |
| Factory version | `0.139.0` |
| Wrapper revision | `linux.1` |
| Git tag | `v0.139.0-linux.1` |
| Debian version | `0.139.0-1` |
| RPM Version | `0.139.0` |
| RPM Release | `2` |
| AppImage | `Factory-0.139.0-linux.1-x86_64.AppImage` |

The release workflow accepts `factory_version`, `wrapper_revision`, and
`source_ref`. Exact DMG acquisition receives only `factory_version`.
`build-info.json`, package-specific build info, acceptance metadata, and the
release manifest record `factoryVersion`, `wrapperRevision`, and the concrete
package version/release. Release verification derives exact filenames from
those fields and rejects inconsistent identities.

`dpkg --compare-versions 0.139.0-1 gt 0.139.0` must pass. RPM metadata must
report `0.139.0-2`, which is newer than the broken `0.139.0-1` package.

## Expression-Safe Bridge Patch

The patcher continues to locate exactly one handler for each of
`updates:getState`, `updates:install`, and `updates:checkNow`, all using the same
Electron alias and JavaScript file. It sorts the handlers by source position
and requires every gap between them to contain only comma/semicolon separators
and whitespace. Any additional expression or statement causes fail-closed
patch drift.

The complete contiguous handler span is replaced by one expression-safe IIFE:

```js
/* factory-linux:linux-native-updater-button */(() => {
  const factoryLinuxUpdateBridge = /* fixed AppImage fallback or fixed package bridge */;
  electron.ipcMain.handle("updates:getState", () => factoryLinuxUpdateBridge.dispatch("getState", {}));
  electron.ipcMain.handle("updates:install", () => factoryLinuxUpdateBridge.dispatch("install", {}));
  electron.ipcMain.handle("updates:checkNow", () => factoryLinuxUpdateBridge.dispatch("checkNow", {}));
})()
```

The declaration is inside the function body, while the injected outer value is
an expression valid in both statement and comma-expression contexts. The fixed
bridge path remains `/usr/lib/factory-desktop/update-bridge.cjs`. The patch
report records matcher `contiguous-ipc-handler-span`, insertion context
`expression-iife`, handler count, and separator evidence. Marker detection
remains idempotent; a foreign or partial marker is rejected rather than treated
as accepted output.

## Whole-Bundle Syntax Gate

`patcher/src/javascript-syntax.js` provides a reusable parse-only validator.
It uses `node:vm` `Script` compilation for the CommonJS Electron main bundles
that contain Factory Linux migration markers. Constructing `vm.Script` parses
the complete source without executing it.

After every patch descriptor and post-patch structural validator has run, the
engine validates every changed or marker-bearing executable JavaScript bundle.
The critical `bundle-javascript-syntax` outcome is appended to
`patch-report.json`. Its evidence contains only file paths, mode, counts, and
bounded parser diagnostics. A syntax failure is written to the failed patch
report and aborts ASAR replacement.

The same helper validates `resources/app.asar` in staged application trees and
again inside extracted deb, RPM, and AppImage payloads. Package builders call
the staged gate before packaging; `inspect-package.js` applies it to the exact
extracted runtime. Because updater candidates and release builds already call
the package builders and inspector, a syntax-invalid candidate cannot reach
accepted, ready, or publish states.

## Release And Watch Data Flow

The release build uses this order:

1. Strictly parse Factory version and wrapper revision.
2. Acquire and accept the exact official Factory DMG using Factory version.
3. Patch ASAR and require structural plus whole-bundle syntax outcomes.
4. Build revisioned deb, RPM, and AppImage packages.
5. Extract and inspect every package, including whole-bundle syntax.
6. Generate revision-aware provenance and checksums.
7. Reverify exact assets in the publish job.
8. Publish `v<factoryVersion>-<wrapperRevision>` only after every gate passes.

Upstream Watch uses the checked-in accepted upstream version and never treats a
GitHub tag as acceptance evidence. A draft or prerelease cannot advance that
value merely because an authenticated workflow token can see it.

## Tests

Tests reproduce the exact previous comma-expression failure before the fix.
They cover expression-safe injection, complete final bundle parsing,
marker-valid but syntax-invalid rejection, idempotence, foreign markers,
staged ASAR rejection, extracted deb/RPM/AppImage rejection, updater candidate
rejection, release publication rejection, wrapper filename/provenance
consistency, deb/RPM ordering, and exact Factory source independence from the
wrapper revision.

Local acceptance uses one bounded temporary root and includes focused tests,
all Node and Rust tests, `make check`, package smoke, the real Factory 0.139.0
harness, `make release-check`, package extraction, staged visible-window runtime
verification, and `git diff --check`.

## Installation And Rollback

The installed Phase 4 fallback remains untouched until the corrected deb has
passed staged runtime verification and a verified fallback package is present.
The independently downloaded corrected public deb is installed only after
remote CI, Package Smoke, release publication, checksum verification, and
package inspection. `allow_active=no` remains unchanged. If corrected runtime
verification fails, the known working Phase 4 package is restored.

Only after the corrected installed baseline passes may the native updater E2E
to Factory `0.140.0` begin.

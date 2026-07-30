# Patching

Phase 2 applies required Linux compatibility patches through descriptors. Each
descriptor defines an id, phase, CI policy, match strategy, apply function, and
post-patch validator. Required patches fail closed: if a matcher does not find
the expected upstream shape or a validator cannot prove the resulting behavior,
the patcher exits non-zero and the build does not continue.

## Required Patches

| Patch | Purpose | Validator Evidence |
|---|---|---|
| `daemon-transport-force-websocket` | Replaces Statsig or hardcoded IPC resolver with WebSocket. | Resolver marker, `.WebSocket`, no hardcoded `.Ipc`, `resolveTransportMode` callsite. |
| `prevent-listen-ipc` | Guards `push("--listen","ipc")` on Linux. | Marker plus Linux guard around daemon spawn args. |
| `system-daemon-adoption` | Adopts the user-owned daemon on `127.0.0.1:37643`. | Health URL, `systemctl --user restart factory-droid-daemon.service`, wait budget `15000ms`. |
| `system-droid-cli-resolver` | Uses the current system `droid` CLI instead of `resources/bin/droid`. | `FACTORY_DROID_PATH`, `command -v droid`, home/local/system lookup paths. |
| `linux-native-updater-button` | Loads the fixed package-owned bridge and replaces one contiguous three-handler span with an expression-safe IIFE. | `contiguous-ipc-handler-span`, `expression-iife`, one fixed bridge load, exact handler counts, AppImage unavailable state, no helper path override. |
| `auto-updater-guard` | Prevents built-in Electron updater calls on Linux. | No unguarded `checkForUpdates`/`quitAndInstall`. |

Packaging validators add required report outcomes for `disable-keyring` and
`protocol-handler`. They verify the launcher, desktop entry, and AppImage
`AppRun` rather than modifying upstream ASAR code.

`bundle-javascript-syntax` is a required post-patch outcome. It uses
`node:vm` to parse, but not execute, every changed or Factory-marker-bearing
CommonJS bundle before ASAR replacement. The staged app and each extracted
deb/RPM/AppImage payload are parsed again at their package boundaries.

The packaged `factory-droid-daemon.service` resolves `droid` and runs
`droid daemon --help` on every service start. Remote relay access is disabled
by default; setting `FACTORY_DROID_REMOTE_ACCESS=1` adds `--remote-access` only
when the currently installed CLI advertises that flag. Adoption uses the local
health endpoint and does not inspect or require the daemon command line.

## Real Bundle Result

Raw Factory Desktop `0.139.0` from the local DMG cache matched the hardcoded
transport shape:

```text
function BVe(){return fc.Ipc}
resolveTransportMode(){... await BVe() ...}
```

All required patches matched, patched, and validated. A second run produced
`alreadyPatched=true` for every required patch and did not change the ASAR hash.

Foreign fork markers such as `linux-daemon-transport-patch` are not accepted as
our idempotence markers. Only `/* factory-linux:<patch-id> */` plus validator
evidence counts as already patched.

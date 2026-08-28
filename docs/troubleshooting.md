# Troubleshooting

## Build And Package

- Version mismatch: compare endpoint, redirect, plist, and requested `VERSION`;
  never override a mismatch.
- Patch failure: follow [patch drift](patch-drift.md); packaging must not run.
- JavaScript syntax failure: inspect the bounded `bundle-javascript-syntax`
  outcome and excerpt. Do not bypass it based on marker counts or snippet-only
  parsing.
- Hygiene failure: fix the exact reported path/mode/link and rebuild isolated
  dependencies with `npm ci --omit=dev --ignore-scripts`.
- AppImage tool failure: inspect `.cache/appimage`, rerun, and never commit it.

## Runtime

- Daemon adoption: check `http://127.0.0.1:37643/health` and the user service.
  Cloud token and `--remote-access` are not adoption requirements.
- Keyring/OAuth: verify protocol MIME/default handler and
  `FACTORY_DISABLE_KEYRING=1`.
- Development mode: ELF must be `/opt/Factory/factory-desktop`, not `electron`.
- Update UI unavailable: native packages require the fixed helper and bridge;
  AppImage is intentionally unavailable and has no native update path.
- No update notification at startup: this is expected to be metadata-only.
  Inspect `factory-update-manager status --json`; startup and `check-now` never
  download or build a candidate.

## Install And Recovery

- `update-available`: click **Update**. Do not run `check-now` expecting it to
  prepare a package; use `factory-update-manager update --pid PID` only when
  exercising the command directly.
- `downloading`, `building`, or `validating`: the user-triggered preparation is
  active. Keep Factory open; polkit and installation occur only after
  `ready-to-install`.
- `ready-to-install`: preparation and validation succeeded. The updater now
  requests polkit authentication and controls the bounded Factory exit. Do not
  quit the app manually to trigger installation.
- `install-failed-manual-action`: copy the updater-owned `manualCommand`, then
  run `reconcile-install` only after the authenticated package command has
  completed. Do not execute arbitrary renderer text or paths.
- `installed` or `rolled-back`: the package-manager version was verified and
  the updater attempts one automatic relaunch through the fixed launcher. No
  manual restart is required; one process restart is inherently needed for new
  Electron code and is performed automatically.
- Relaunch failure: the verified terminal state remains. Launch the fixed shim
  manually and inspect `relaunchError`; do not start another install loop.
- Polkit denial or unavailability: ensure an authentication agent exists or
  use the updater-generated authenticated terminal fallback. No retry loop or
  passwordless policy is expected.
- A stale `downloading`, `building`, `validating`, or `installing` state after
  an updater crash must recover to `failed` or
  `install-failed-manual-action`. If it does not, inspect the updater journal
  and state JSON rather than repeatedly clicking Update.

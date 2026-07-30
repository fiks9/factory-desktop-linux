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
- Update UI unavailable: native packages require the fixed helper/bridge;
  AppImage is intentionally unavailable.

## Install And Recovery

- `ReadyPendingExit`: close Factory; retain candidate workspace.
- `InstallFailedManualAction`: copy updater-owned `manualCommand`; after install run
  `reconcile-install`. Do not execute arbitrary renderer text/paths.
- Relaunch failure: verified terminal state remains; launch fixed shim manually and
  inspect `relaunchError`.
- Polkit denial: ensure an agent exists or use authenticated terminal fallback.
  No retry loop or passwordless policy is expected.

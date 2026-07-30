# Patch Drift

Required matcher or validator drift blocks release. Do not weaken a matcher, mark
a required outcome optional, or continue packaging to obtain artifacts.

Diagnostics contain Factory version, raw ASAR SHA-256, bundle fingerprint, failed
patch IDs, matcher class/count, evidence, validator errors, and at most three
1024-character excerpts around known anchors. They never contain an ASAR or full
upstream bundle. Public issues contain hashes, failed IDs, short reasons, and a
workflow link. Review excerpts before public upload.

Reproduce with an authorized DMG:

```bash
make build-app DMG=/absolute/path/Factory.dmg VERSION=0.140.0
node patcher/src/cli.js /absolute/path/app.asar /tmp/patch-report.json
```

Compare the new shape with descriptor `matchStrategy`, add only a minimal
synthetic regression shape, update matcher and validator together, then require
first-run patching, second-run idempotence, and package validators.

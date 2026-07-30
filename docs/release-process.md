# Release Process

## Preconditions

The upstream version must be exact, the source ref reviewed and clean, local
`make release-check` green, and every required patch accepted. Confirm no DMG,
ASAR, extracted app, package, or proprietary diagnostic is tracked.

## Manual Workflow

Run `.github/workflows/release.yml` from the protected default branch with
`version` and `source_ref`. The ref must resolve to a commit in that triggering
branch's history. The read-only build job downloads the official DMG, checks version/hash/structure, patches the
raw ASAR, validates required outcomes, builds all formats, extracts and inspects
them, then verifies provenance and checksums.

The bundle contains exact-version `.deb`, `.rpm`, `.AppImage`, `checksums.txt`,
release `build-info.json`, `patch-report.json`, `acceptance-summary.json`, and
optional detached `.asc` signatures only when a signing key exists.

Only `publish` has `contents: write`. It checks out the trusted workflow commit
without persisted credentials, not the caller-selected source commit. It then
revalidates exact assets, requested version, resolved source commit, package
hashes/sizes, patch-report binding, acceptance summary, and checksums before it
creates the GitHub Release. It never receives the source DMG or raw/patched ASAR.

## Provenance And Checksums

Package metadata records Factory/Electron versions, DMG hash, raw/patched ASAR
hashes, patch-report hash, package format/native status, binary, repository and
patcher commits, patcher version, run ID, timestamp, and architecture. Release
metadata binds exact inspected filenames, sizes, formats, and hashes. Each
package's extracted build metadata must equal the source provenance before the
release manifest can be created.

`checksums.txt` covers three packages and three JSON metadata files. Missing or
extra filenames, paths, drift, and `latest`/`stable` aliases fail validation.

## Signing

Default releases are checksum-only. Without `RELEASE_SIGNING_KEY`, the workflow
creates no signature and makes no signing claim. A future production signing key
must be dedicated, rotated, publish its fingerprint out-of-band, and remain
available only to the publication job.

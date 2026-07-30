# Release Process

## Preconditions

The upstream version must be exact, the source ref reviewed and clean, local
`make release-check` green, and every required patch accepted. Confirm no DMG,
ASAR, extracted app, package, or proprietary diagnostic is tracked.

## Manual Workflow

Run `.github/workflows/release.yml` from the protected default branch with
`factory_version`, `wrapper_revision`, and `source_ref`. The ref must resolve to a commit in that triggering
branch's history. The read-only build job downloads the official DMG, checks version/hash/structure, patches the
raw ASAR, validates required outcomes, builds all formats, extracts and inspects
them, then verifies provenance and checksums.

Factory and wrapper identities are deliberately separate. For the corrected
Factory `0.139.0` wrapper, use `factory_version=0.139.0` and
`wrapper_revision=linux.1`. This produces tag `v0.139.0-linux.1`, deb version
`0.139.0-1`, RPM `0.139.0-2`, and
`Factory-0.139.0-linux.1-x86_64.AppImage`. The wrapper revision is never passed
to exact DMG URL construction or embedded Factory-version acceptance.

Release acquisition is deterministic and version-addressed. After strict
version parsing, the downloader constructs the official object path
`https://s3.us-west-1.amazonaws.com/downloads.factory.ai/factory-desktop/releases/<version>/darwin/x64/Factory-<version>-x64.dmg`.
Only that HTTPS host and exact path are accepted; credentials, ports, query
strings, fragments, foreign hosts, and redirects to another version are rejected.
The latest-version API is discovery-only and is never substituted for an exact
historical release source.

The patcher compiles every changed or `factory-linux:` marker-bearing CommonJS
bundle with `node:vm` after patching and before ASAR replacement. Package
builders repeat the same parse-only gate for the staged app, and package
inspection repeats it against the exact extracted deb/RPM/AppImage runtime.
`bundle-javascript-syntax` is a required patch-report outcome; any parse failure
stops packaging and publication.

The bundle contains exact-version and wrapper-revision `.deb`, `.rpm`, `.AppImage`, `checksums.txt`,
release `build-info.json`, `patch-report.json`, `acceptance-summary.json`, and
optional detached `.asc` signatures only when a signing key exists.

Only `publish` has `contents: write`. It checks out the trusted workflow commit
without persisted credentials, not the caller-selected source commit. It then
revalidates exact assets, requested version, resolved source commit, package
hashes/sizes, patch-report binding, acceptance summary, and checksums before it
creates the GitHub Release. It never receives the source DMG or raw/patched ASAR.

## Provenance And Checksums

Package metadata records Factory/Electron versions, wrapper revision, concrete
package version/release, DMG hash, raw/patched ASAR
hashes, patch-report hash, package format/native status, binary, repository and
patcher commits, patcher version, run ID, timestamp, and architecture. Release
metadata binds exact inspected filenames, sizes, formats, and hashes. Each
package's extracted build metadata must equal the source provenance before the
release manifest can be created.

DMGs stream into the content-addressed cache as `Factory-<sha256>.dmg`. The
version index is written only after the existing DMG acceptance has verified the
embedded Factory version, required app structure, Electron metadata, and the
downloaded SHA-256. Failed downloads and rejected DMGs remain unindexed.

`checksums.txt` covers three packages and three JSON metadata files. Missing or
extra filenames, paths, drift, and `latest`/`stable` aliases fail validation.

## Signing

Default releases are checksum-only. Without `RELEASE_SIGNING_KEY`, the workflow
creates no signature and makes no signing claim. A future production signing key
must be dedicated, rotated, publish its fingerprint out-of-band, and remain
available only to the publication job.

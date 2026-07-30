# Security Model

The release boundary trusts official Factory endpoints, repository-owned code at
the selected commit, and blocking inspection results. DMG metadata, renderer text,
user manifests, package exit codes, and caches remain untrusted until validated.

Exact DMG acquisition is confined to HTTPS on `s3.us-west-1.amazonaws.com` and
the `downloads.factory.ai/factory-desktop/releases/<version>/darwin/x64` object
path derived only from a strictly parsed version. Every redirect is revalidated
against the requested version and the same host/path contract. The mutable
latest-version endpoint is used for discovery, not as an exact historical binary
source.

CI uses no `pull_request_target`. CI/build jobs have `contents: read`; only final
publication has `contents: write`. Signing secrets, when configured, exist only
there. The privileged job uses verifier code from the trusted workflow commit,
does not persist checkout credentials, and rejects source refs outside that
commit's history. PR artifacts are synthetic; real DMGs/ASARs are never uploaded.
Patch diagnostics are bounded metadata/excerpts.

Release identity separates the exact upstream Factory version from the Linux
wrapper revision. Strict `linux.N` parsing derives the tag, deb revision, RPM
release, AppImage filename, and package provenance. Exact DMG acquisition and
embedded version acceptance receive only the Factory version. A wrapper tag or
draft release cannot become accepted-upstream evidence.

An upstream version is bound to a content-addressed DMG hash only after DMG
metadata and exact-version acceptance. A rejected response may remain as an
unreferenced cache blob, but it cannot poison the version index.

Structural marker validation is not treated as JavaScript validity. The
patcher, staged package builders, and extracted package inspector independently
parse the complete marker-bearing bundles without executing them. Any syntax
error remains fail-closed through updater candidate acceptance and release
publication.

Native deb/rpm packages contain the updater. AppImage has no privileged native
updater and reports `update-manager-unavailable`. Default install needs polkit
authentication or manual fallback. `install-approved-package` remains
`allow_active=no`; `unattended = true` does not bypass authentication. Passwordless
activation requires a separate privileged live E2E review.

Root approvals enforce 0700 directories, 0600 records, strict IDs, metadata/hash
and patch-report binding, expiry, confinement, no-follow reads, and atomic consume.
Install/rollback success requires an exact package-manager version query.

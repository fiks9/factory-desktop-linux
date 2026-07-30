# Security Model

The release boundary trusts official Factory endpoints, repository-owned code at
the selected commit, and blocking inspection results. DMG metadata, renderer text,
user manifests, package exit codes, and caches remain untrusted until validated.

CI uses no `pull_request_target`. CI/build jobs have `contents: read`; only final
publication has `contents: write`. Signing secrets, when configured, exist only
there. The privileged job uses verifier code from the trusted workflow commit,
does not persist checkout credentials, and rejects source refs outside that
commit's history. PR artifacts are synthetic; real DMGs/ASARs are never uploaded.
Patch diagnostics are bounded metadata/excerpts.

An upstream version is bound to a content-addressed DMG hash only after DMG
metadata and exact-version acceptance. A rejected response may remain as an
unreferenced cache blob, but it cannot poison the version index.

Native deb/rpm packages contain the updater. AppImage has no privileged native
updater and reports `update-manager-unavailable`. Default install needs polkit
authentication or manual fallback. `install-approved-package` remains
`allow_active=no`; `unattended = true` does not bypass authentication. Passwordless
activation requires a separate privileged live E2E review.

Root approvals enforce 0700 directories, 0600 records, strict IDs, metadata/hash
and patch-report binding, expiry, confinement, no-follow reads, and atomic consume.
Install/rollback success requires an exact package-manager version query.

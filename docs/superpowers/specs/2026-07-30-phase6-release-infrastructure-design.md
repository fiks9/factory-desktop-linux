# Phase 6 Release Infrastructure Design

## Goal

Provide a fail-closed upstream watch, release pipeline, artifact provenance,
patch-drift diagnostics, and maintainer runbook without committing or publishing
proprietary source payloads.

## Architecture

GitHub workflows remain thin orchestrators. Repository-owned Node scripts own
the version, provenance, checksum, diagnostic, and release verdict contracts so
the same behavior is exercised locally and in CI. The existing `build-app.js`
and package builders remain the single source of truth for DMG acceptance,
patching, runtime assembly, hygiene, and package inspection.

The daily upstream watch first validates the official latest-version response.
It compares that exact version with `release/accepted-upstream.json`, falling
back to the latest published release when one exists. Only a new version runs a
DMG/patch probe. The content-addressed download directory is restored through
the GitHub Actions cache, so an already known DMG hash is reused. New versions,
network failures, invalid metadata, and patch drift produce a deduplicated issue
and job summary. No watch job publishes packages or releases.

The manual release workflow accepts an exact Factory version and source ref.
It checks out that ref, downloads and accepts the official DMG, applies every
required patch, builds all formats, extracts and inspects each package, writes
release metadata, validates exact checksums, and runs the relevant test matrix.
Only the final release job receives `contents: write`; all build jobs remain
`contents: read`. The selected source commit must be in the triggering protected
branch's history, while the privileged job runs verifier code from the trusted
workflow commit with checkout credentials disabled. Release assets are uploaded
only after the acceptance verdict.

## Provenance Contract

The staged app records source Factory and Electron versions, DMG hash, raw and
patched ASAR hashes, patch-report hash, binary name, repository commit, workflow
run ID, build timestamp, and target architecture. Each package builder writes
its own `packageFormat` and `nativePackage` fields into the copy embedded in that
package. Package inspection validates those fields against the archive format.

The release-side `build-info.json` binds the source identity to all inspected
package filenames, formats, sizes, and hashes. `checksums.txt` covers the three
package files plus `build-info.json`, `patch-report.json`, and
`acceptance-summary.json`, sorted by exact filename. The checksum file cannot
refer to aliases such as `latest` or `stable`.

Publication rechecks that every package hash and size matches the manifest,
that the patch report hashes bind the raw/patched ASAR, and that the acceptance
summary matches the report and inspected package hashes.

## Patch Drift

Patch failures stop before packaging. A bounded diagnostic writer records the
Factory version, raw ASAR hash, bundle fingerprint, failed patch IDs, matcher
class/count, evidence, validator errors, and small escaped excerpts around
relevant matcher evidence. It never stores the ASAR or a complete upstream
bundle. The patch report and diagnostic JSON are uploaded only on failure and
linked from the job summary and deduplicated issue.

## Local Release Gate

`make release-check` runs repository checks, Rust and Node tests, the synthetic
package smoke, real local fixture harness, provenance/checksum contract tests,
and generated-artifact hygiene. It snapshots the source-tree status before the
gate and requires the same status afterward, allowing Phase 6 itself to be
tested before its single commit while still proving that the gate generated no
new workspace files. GitHub release runs additionally require a pristine
checkout.

## Security And Limitations

No workflow uses `pull_request_target`. Read-only CI jobs receive no secrets.
Only the final GitHub release job has write access. Proprietary DMGs and ASARs
remain in ephemeral/cache storage and are never uploaded by successful PR jobs.
Diagnostic excerpts are bounded and metadata-only.

Checksum-only releases are the honest default. Detached signatures are emitted
only when a repository signing key is configured for the dedicated release job;
absence of a key is not described as signed provenance. Native deb/rpm packages
include the updater. AppImage has no privileged native updater. Polkit remains
authenticated, `install-approved-package` remains inactive, and
`unattended = true` does not bypass authentication pending a separate live root
E2E verdict.

## Verification

Tests cover upstream metadata comparison, provenance validation, exact checksum
coverage, package format binding, patch diagnostic redaction/bounds, workflow
permissions and release ordering, final regression matrix entries, and dirty
artifact detection. The Phase 6 final gate also reruns all existing Rust, Node,
synthetic package, and real 0.139.0 regression tests.

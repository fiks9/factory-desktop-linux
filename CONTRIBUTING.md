# Contributing to Factory Desktop for Linux

Thanks for helping improve Factory Desktop for Linux. Contributions are
welcome for Linux compatibility, packaging, updater behavior, tests,
documentation, and maintainer tooling.

This is an unofficial compatibility project. Factory Desktop, its application
bundle, assets, and Droid are proprietary upstream software and are not covered
by this repository's MIT License.

## Before You Start

- Search existing issues and pull requests to avoid duplicate work.
- Keep each change focused on one bug, feature, or maintenance task.
- Read the relevant documentation under [`docs/`](docs/) before changing the
  patcher, packaging pipeline, updater, or release automation.
- For security-sensitive changes, preserve the fail-closed behavior described
  in [`docs/security-model.md`](docs/security-model.md).

Good bug reports include the Linux distribution and version, desktop
environment, package format, Factory version, exact reproduction steps, and
sanitized logs. Never include credentials, authentication tokens, or private
Factory data.

## Development Workflow

Fork the repository, create a focused branch, and make changes in the source of
truth rather than generated output. The main areas are:

- `patcher/` for ASAR patch contracts and validators;
- `scripts/` for acquisition, staging, inspection, and release gates;
- `packaging/` and `launcher/` for Linux integration;
- `updater/` for the Rust update manager;
- `tests/` for synthetic and package-level regression coverage.

Use an authorized Factory DMG when a real-bundle test is required. Downloads,
extracted applications, ASAR files, generated packages, caches, and other
proprietary payloads must stay outside git. Do not add `.dmg`, `.asar`, `.deb`,
`.rpm`, or `.AppImage` files to a commit.

## Validation

Run checks appropriate to the change. The standard local commands are:

```bash
make check
make test
make package-smoke VERSION=0.139.0 DIST_DIR=/tmp/factory-package-smoke
make test-real-bundles
```

Release-affecting changes should also pass the blocking gate:

```bash
FACTORY_REQUIRE_CLEAN_GIT=1 make release-check
```

If a proprietary real-bundle fixture is unavailable, report it as `SKIP`; do
not present an unexecuted test as a pass. Mention every test you did not run in
the pull request.

## Pull Requests

A pull request should explain:

- what changed and why;
- which source-of-truth files were modified;
- the user-visible or security impact;
- the validation that was run;
- known limitations or follow-up work.

Add or update regression tests for behavioral changes. Avoid unrelated
refactors, formatting churn, generated artifacts, and manual release assets in
the same pull request. Required patch or validator failures must remain
fail-closed.

## Security and Privilege Boundaries

Do not weaken package validation, rollback verification, updater locks, path or
ownership checks, or polkit authentication to make a change pass. In
particular, `install-approved-package` must remain `allow_active=no` unless a
separate privileged live end-to-end review explicitly approves a policy change.
Do not add `NOPASSWD`, setuid helpers, arbitrary renderer execution, or
user-writable privileged bridges.

Please report security-sensitive issues privately to the maintainers rather
than publishing exploit details in a public issue.

## Commit Quality

Use clear, focused commit messages and keep generated output out of commits.
Conventional Commit-style subjects such as `fix:`, `feat:`, `docs:`, and
`test:` are preferred.

Thank you for contributing carefully and keeping the Linux port reviewable,
reproducible, and safe.

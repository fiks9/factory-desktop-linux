# Architecture

The project converts an authorized Factory Desktop macOS DMG into a Linux
application without storing the upstream payload in this repository.

## Phase Boundaries

1. Phase 0 defines repository, legal, testing, and generated-artifact
   contracts.
2. Phase 1 will add deterministic DMG caching/extraction and a minimal Debian
   package.
3. Phase 2 will add required ASAR patch descriptors and post-patch validators.
4. Phase 3 will add package hygiene, AppImage, and update-builder staging.
5. Phase 4 will add the Rust update manager and transactional installation.
6. Phase 5 will connect the in-app update UX and polkit fallback paths.
7. Phase 6 will add scheduled upstream checks and releases.

## Non-Negotiable Invariants

- Required patches are fail-closed.
- Patch reports are evidence, not a success marker: validators must prove the
  expected behavior.
- Builds happen in a sibling candidate directory and are promoted only after
  acceptance passes.
- Update-builder dependencies are installed inside the staged builder; CI
  `node_modules` are never copied as-is.
- No package may contain an absolute symlink to a build workspace or a binary
  without its executable bit.
- The Droid daemon is adopted by health at `127.0.0.1:37643`; exact cmdline
  matching is not an adoption criterion.
- The daemon health wait budget is at least 15 seconds.

## Runtime Identity

The Linux app and the user-owned Droid service will share the current resolved
`droid` executable. The resolver must re-check the executable and supported
daemon flags after Droid self-updates; it must not cache a path or version for
the lifetime of the installation.

# Corrected Release Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the statement-unsafe updater bridge, make whole-bundle JavaScript parsing a blocking acceptance gate, publish and install the explicit `v0.139.0-linux.1` correction, then run the native updater E2E to Factory `0.140.0` without weakening `allow_active=no`.

**Architecture:** Replace the three adjacent updater IPC handlers as one expression-safe IIFE and validate every changed or Factory-marker-bearing CommonJS bundle with `node:vm` before ASAR replacement, package creation, and package acceptance. Keep upstream Factory identity separate from wrapper/package revision, derive all filenames and package versions from one strict release-identity helper, and use checked-in accepted-upstream metadata as the only watch baseline. Operational rollout keeps the working Phase 4 fallback until a staged corrected runtime and rollback package are verified, then publishes, independently verifies, installs, and exercises the updater under fail-closed gates.

**Tech Stack:** Node.js 22 (`node:test`, `node:vm`, ASAR tooling), Rust 1.96 updater integration, Debian/RPM/AppImage packaging, GitHub Actions, `dpkg`/RPM version queries, Electron runtime smoke, systemd user services.

---

### Task 1: Reproduce The Comma-Expression Failure

**Files:**
- Modify: `patcher/tests/patcher.test.js`
- Test: `patcher/tests/patcher.test.js`

- [ ] **Step 1: Add a synthetic upstream fixture whose three update handlers are comma-expression operands**

Create the source through the existing fixture helper so the relevant tail is structurally equivalent to the failed 0.139.0 bundle:

```js
const main = [
  requiredSyntheticBundlePrefix(),
  'function start(){return (boot(),W.ipcMain.handle("updates:getState",()=>oldState()),W.ipcMain.handle("updates:install",()=>oldInstall()),W.ipcMain.handle("updates:checkNow",()=>oldCheck()),finish())}',
].join("");
```

After `patchAsar`, load the complete patched JavaScript file and require parse-only compilation:

```js
assert.doesNotThrow(() => new vm.Script(patchedSource, { filename: "main.js" }));
assert.match(patchedSource, /factory-linux:linux-native-updater-button/);
assert.match(patchedSource, /\/\* factory-linux:linux-native-updater-button \*\/\(\(\)=>\{/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='comma-expression' patcher/tests/patcher.test.js
```

Expected: FAIL with `SyntaxError: Unexpected token 'const'` from parsing the complete patched source.

- [ ] **Step 3: Add drift coverage before changing production code**

Add focused tests proving the patch rejects:

```js
test("native updater rejects unrelated code between required handlers", async () => {
  // Insert `,sideEffect(),` between two handler spans.
  await assert.rejects(() => patchFixture(source), /linux-native-updater-button/);
});

test("native updater rejects a foreign partial marker", async () => {
  // Marker exists but exact IIFE/three-handler contract does not.
  await assert.rejects(() => patchFixture(source), /linux-native-updater-button/);
});
```

- [ ] **Step 4: Run the focused tests and verify both fail for the intended missing behavior**

Run the same `node --test` command with patterns `comma-expression|unrelated code|foreign partial marker`. Expected: the parseability/evidence assertions fail while the existing validator still accepts the unsafe layout.

### Task 2: Replace The Handlers With One Expression-Safe IIFE

**Files:**
- Modify: `patcher/src/patches.js:135-185`
- Modify: `patcher/src/validators.js:59-84`
- Test: `patcher/tests/patcher.test.js`

- [ ] **Step 1: Add a separator-only span helper**

Implement a helper that sorts handlers in ascending source order and rejects every gap except commas, semicolons, and whitespace:

```js
function contiguousHandlerSpan(handlers, content) {
  const ordered = [...handlers].sort((left, right) => left.start - right.start);
  const separators = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const gap = content.slice(ordered[index - 1].end, ordered[index].start);
    if (!/^[,;\s]*$/.test(gap)) return null;
    separators.push(gap);
  }
  return { start: ordered[0].start, end: ordered.at(-1).end, ordered, separators };
}
```

- [ ] **Step 2: Replace the complete span with one IIFE expression**

Generate one deterministic replacement:

```js
const replacement = `${marker}(()=>{const ${bridgeName}=process.env.FACTORY_UPDATE_MANAGER_UNAVAILABLE==="1"?${appImageFallback}:require("/usr/lib/factory-desktop/update-bridge.cjs").createBridge({electron:${alias}});${channels.map(([, action]) => `${alias}.ipcMain.handle("updates:${action}",()=>${bridgeName}.dispatch("${action}",{}))`).join(";")}})()`;
```

Replace `content.slice(span.start, span.end)` once and return evidence:

```js
{
  matcher: "contiguous-ipc-handler-span",
  insertionContext: "expression-iife",
  handlerCount: 3,
  separators: span.separators,
}
```

- [ ] **Step 3: Tighten the structural validator**

Require exactly one marker, one fixed bridge load, one IIFE shape, one dispatch per action, zero legacy handlers, AppImage fallback, and no path override. Include `expressionIife` and `handlerCount` in evidence.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern='comma-expression|native updater|foreign partial marker|unrelated code' patcher/tests/patcher.test.js
```

Expected: PASS, including a second `patchAsar` run that leaves the bundle byte-identical and parseable.

### Task 3: Add The Parse-Only Whole-Bundle Gate

**Files:**
- Create: `patcher/src/javascript-syntax.js`
- Modify: `patcher/src/engine.js:1-149`
- Modify: `patcher/tests/patcher.test.js`
- Test: `patcher/tests/patcher.test.js`

- [ ] **Step 1: Add RED unit coverage for complete-source parsing**

Define the desired API in the test:

```js
const { validateJavaScriptFiles } = require("../src/javascript-syntax");

test("syntax gate rejects marker-bearing invalid complete bundles", () => {
  const result = validateJavaScriptFiles([
    { path: "main.js", content: '(()=>0),/* factory-linux:test */const broken=1' },
  ], { changedPaths: new Set() });
  assert.equal(result.validationPassed, false);
  assert.equal(result.evidence.checkedFiles, 1);
  assert.match(result.errors[0], /main\.js.*Unexpected token/);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test --test-name-pattern='syntax gate' patcher/tests/patcher.test.js
```

Expected: FAIL because `patcher/src/javascript-syntax.js` does not exist.

- [ ] **Step 3: Implement `validateJavaScriptFiles` with `vm.Script`**

Create a parse-only helper:

```js
"use strict";
const vm = require("node:vm");

function markerBearing(file) {
  return /factory-linux:[a-z0-9-]+/.test(file.content);
}

function validateJavaScriptFiles(files, options = {}) {
  const changedPaths = options.changedPaths || new Set();
  const selected = files.filter((file) => changedPaths.has(file.path) || markerBearing(file));
  const failures = [];
  for (const file of selected) {
    try { new vm.Script(file.content, { filename: file.path, displayErrors: true }); }
    catch (error) { failures.push({ file: file.path, message: String(error.message).slice(0, 512) }); }
  }
  return {
    validationPassed: failures.length === 0 && selected.length > 0,
    errors: failures.map((failure) => `${failure.file}: ${failure.message}`),
    evidence: { mode: "commonjs-script", checkedFiles: selected.length, files: selected.map((file) => file.path), failures },
  };
}

module.exports = { validateJavaScriptFiles };
```

- [ ] **Step 4: Append a critical `bundle-javascript-syntax` engine outcome before ASAR replacement**

Track `changedPaths` from `originalContents`, call the helper after patch and packaging validators, append:

```js
{
  id: "bundle-javascript-syntax",
  description: "Parse changed and Factory-marker-bearing JavaScript bundles",
  phase: "post-patch-validation",
  ciPolicy: CRITICAL_POLICY,
  matchStrategy: "node:vm complete CommonJS script parse",
  matched: syntax.evidence.checkedFiles > 0,
  patched: false,
  alreadyPatched: true,
  validationPassed: syntax.validationPassed,
  errors: syntax.errors,
  evidence: syntax.evidence,
}
```

On failure, write the report with `changed:false`, keep the ASAR hash unchanged, attach bounded diagnostics, and throw `Required patch failed: bundle-javascript-syntax`.

- [ ] **Step 5: Prove the old unsafe output is rejected before replacement and the fixed output passes**

Add tests for valid patched source, marker-valid but syntactically invalid source, failed report outcome, original ASAR unchanged, and idempotent reparse. Run all patcher tests and expect PASS.

### Task 4: Reuse The Syntax Gate In Staged And Extracted Packages

**Files:**
- Create: `scripts/validate-app-javascript.js`
- Modify: `scripts/package-deb.js`
- Modify: `scripts/package-rpm.js`
- Modify: `scripts/package-appimage.js`
- Modify: `scripts/inspect-package.js`
- Modify: `tests/package-hygiene.test.js`
- Test: `tests/package-hygiene.test.js`

- [ ] **Step 1: Add RED fixtures for staged and extracted invalid ASARs**

Extend package fixtures so `.factory-linux/patch-report.json` and marker counts remain valid while `resources/app.asar` contains a marker-bearing file with invalid complete syntax. Assert each entry point rejects with `bundle JavaScript syntax validation failed`:

```js
assert.throws(() => buildDeb({ appDir, version, outputDir }), /JavaScript syntax/);
assert.throws(() => buildRpm({ appDir, version, outputDir }), /JavaScript syntax/);
await assert.rejects(() => buildAppImage({ appDir, version, outputDir }), /JavaScript syntax/);
assert.throws(() => inspectPackage(artifact), /JavaScript syntax/);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='JavaScript syntax|invalid ASAR' tests/package-hygiene.test.js
```

Expected: FAIL because package builders and inspector do not parse embedded bundles.

- [ ] **Step 3: Implement staged ASAR validation**

Create `validateAppJavaScript(appDir)` that loads `resources/app.asar` with `patcher/src/engine.makeFiles`, passes all marker-bearing files to `validateJavaScriptFiles`, requires `checkedFiles > 0`, and throws a bounded error carrying the syntax outcome.

- [ ] **Step 4: Call the helper at every package boundary**

Call `validateAppJavaScript(appDir)` immediately before package staging in all three builders. In `inspectExtracted`, locate the exact packaged `resources/app.asar`, call the same helper on the extracted application root, and include `javascriptSyntax` evidence in inspection JSON.

- [ ] **Step 5: Run deb/RPM/AppImage regression tests and all package hygiene tests**

Expected: each invalid staged or extracted package fails closed; all valid synthetic packages report `javascriptSyntax.validationPassed === true`.

### Task 5: Prove Updater And Release Rejection Propagate

**Files:**
- Modify: `updater/tests/builder.rs`
- Modify: `tests/release-infrastructure.test.js`
- Test: `updater/tests/builder.rs`
- Test: `tests/release-infrastructure.test.js`

- [ ] **Step 1: Add a Rust RED test for syntax-rejecting package inspection**

Extend `write_node_fixture` with a distinct inspector mode that exits `1` and writes `Package inspection failed: bundle JavaScript syntax validation failed`. Assert:

```rust
let result = builder.build(request);
assert!(result.unwrap_err().to_string().contains("JavaScript syntax"));
assert!(!workspace.exists());
```

- [ ] **Step 2: Add a release RED test**

Stub `inspectPackage`/a fixture package so `buildRelease` receives valid-looking markers but extracted syntax validation fails. Assert no accepted manifest/checksums are created and the error is categorized as a blocking validation failure.

- [ ] **Step 3: Run both focused tests and verify RED where propagation details are missing**

Run:

```bash
cargo test --manifest-path updater/Cargo.toml builder -- --nocapture
node --test --test-name-pattern='syntax.*release|release.*syntax' tests/release-infrastructure.test.js
```

- [ ] **Step 4: Make only the propagation/error-reporting changes needed for GREEN**

Keep the Rust builder dependent on `inspect-package.js` as the source of truth. Ensure `release-build.js` never copies artifacts or writes the accepted bundle after a syntax rejection, while preserving diagnostic output outside release assets.

### Task 6: Introduce One Strict Wrapper Release Identity

**Files:**
- Create: `scripts/release-identity.js`
- Modify: `scripts/package-deb.js`
- Modify: `scripts/package-rpm.js`
- Modify: `scripts/package-appimage.js`
- Modify: `scripts/release-metadata.js`
- Modify: `tests/release-infrastructure.test.js`
- Test: `tests/release-infrastructure.test.js`

- [ ] **Step 1: Add RED identity and ordering tests**

Define the exact contract:

```js
assert.deepEqual(releaseIdentity("0.139.0", "linux.1"), {
  factoryVersion: "0.139.0",
  wrapperRevision: "linux.1",
  tag: "v0.139.0-linux.1",
  debVersion: "0.139.0-1",
  rpmVersion: "0.139.0",
  rpmRelease: "2",
  appImageFilename: "Factory-0.139.0-linux.1-x86_64.AppImage",
  debFilename: "factory-desktop_0.139.0-1_amd64.deb",
  rpmFilename: "factory-desktop-0.139.0-2.x86_64.rpm",
});
```

Reject invalid Factory versions, wrapper revisions other than the supported `linux.<positive integer>` form, slashes, whitespace, shell metacharacters, and version strings that mix wrapper identity into exact DMG acquisition.

- [ ] **Step 2: Verify RED**

Run the focused release identity tests. Expected: FAIL because `release-identity.js` does not exist and builders still produce unrevisioned names.

- [ ] **Step 3: Implement strict parsing and concrete package mapping**

Create `parseWrapperRevision` and `releaseIdentity`. Map `linux.1` to deb revision `1` and RPM release `2`, preserving future monotonic `linux.N` mapping as deb `-N` and RPM release `N+1`. Return only validated plain strings.

- [ ] **Step 4: Thread identity through all builders**

Add optional `wrapperRevision` to builder option objects. Native updater builds continue to omit it and preserve upstream-version-only package identity. Release builds pass the revision and require exact corrected filenames/package metadata. Do not pass wrapper revision to `buildApp`, `acquireExactDmg`, `extractDmg`, or patching.

- [ ] **Step 5: Record package identity in provenance**

Bump internal `build-info.json` schema only if necessary; otherwise add backward-compatible required release fields:

```js
wrapperRevision,
packageVersion,
packageRelease,
```

Source provenance records `wrapperRevision`; each package-specific embedded build info records its concrete version/release. `createReleaseManifest` compares Factory version to upstream identity and package metadata to package identity rather than requiring every package version string to equal `factoryVersion`.

- [ ] **Step 6: Prove ordering with host tools**

Execute in tests when available:

```bash
dpkg --compare-versions 0.139.0-1 gt 0.139.0
rpm --eval '%{lua:print(rpm.vercmp("0.139.0-2", "0.139.0-1"))}'
```

Require positive ordering; skip only if the corresponding package manager is absent and report that skip explicitly.

### Task 7: Make Release Metadata And Workflow Revision-Aware

**Files:**
- Modify: `scripts/release-build.js`
- Modify: `scripts/release-metadata.js`
- Modify: `.github/workflows/release.yml`
- Modify: `tests/release-infrastructure.test.js`
- Modify: `docs/release-process.md`
- Modify: `docs/maintainer-runbook.md`
- Test: `tests/release-infrastructure.test.js`

- [ ] **Step 1: Add RED workflow and bundle-verifier tests**

Require manual inputs `factory_version`, `wrapper_revision`, and `source_ref`; concurrency keyed by both identities; release tag/name derived from `releaseIdentity`; exact DMG acquisition passed only `factory_version`; corrected asset names required by `verifyReleaseBundle`.

- [ ] **Step 2: Verify RED against the current `version` workflow**

Run the focused release infrastructure tests. Expected: FAIL because the workflow exposes a single `version` input and publishes `v0.139.0`-style assets.

- [ ] **Step 3: Update release build CLI and metadata**

Use:

```bash
node scripts/release-build.js \
  --factory-version 0.139.0 \
  --wrapper-revision linux.1 \
  --output-dir "$RUNNER_TEMP/release-assets"
```

Validate inputs before network access. Pass only `factoryVersion` into exact DMG acquisition. Generate acceptance summary, manifest, checksums, and package names from the identity helper.

- [ ] **Step 4: Update publish verification and release creation**

The publish job downloads the accepted workflow artifact, reruns `verifyReleaseBundle` with `factoryVersion`, `wrapperRevision`, and the resolved source commit, then creates `v0.139.0-linux.1`. It must not upload diagnostic files, DMG, ASAR, or fake signatures and must retain checksum-only wording.

- [ ] **Step 5: Update operator docs with exact corrected invocation**

Document the wrapper/upstream distinction, package ordering, old broken draft, corrected tag, and no signing/passwordless claims.

### Task 8: Remove GitHub Latest From Accepted-Version Resolution

**Files:**
- Modify: `.github/workflows/upstream-watch.yml`
- Modify: `tests/release-infrastructure.test.js`
- Modify: `docs/maintainer-runbook.md`
- Test: `tests/release-infrastructure.test.js`

- [ ] **Step 1: Add RED workflow assertions**

Require the workflow to read only `release/accepted-upstream.json` for `--accepted-version` and assert it contains no `releases/latest`, tag-derived version promotion, or dependency on draft visibility.

- [ ] **Step 2: Verify RED**

Run the focused watch workflow test. Expected: FAIL because current YAML calls `repos/.../releases/latest`.

- [ ] **Step 3: Simplify accepted version resolution**

Set the output directly from:

```bash
accepted=$(node -e 'const {readAcceptedVersion}=require("./scripts/upstream-watch");process.stdout.write(readAcceptedVersion("release/accepted-upstream.json"))')
```

Keep latest metadata only for discovery/probe. Do not mutate `accepted-upstream.json` in scheduled runs and do not infer acceptance from tags/releases.

- [ ] **Step 4: Run watch/release infrastructure tests and verify GREEN**

### Task 9: Complete Local Regression And Release Gates

**Files:**
- Modify: `Makefile`
- Modify: `scripts/release-check.js`
- Modify: `tests/release-infrastructure.test.js`
- Modify: `docs/maintainer-runbook.md`

- [ ] **Step 1: Add RED release-check assertions for one bounded root**

Require `FACTORY_TEST_TMP_ROOT`, package smoke, real harness, release metadata verification, syntax inspection, generated-artifact checks, and unchanged worktree to share one parent `TMPDIR`. Assert the release gate checks the `bundle-javascript-syntax` outcome.

- [ ] **Step 2: Implement the bounded-root wiring**

`release-check.js` creates one `0700` root, exports `TMPDIR`, `FACTORY_TEST_TMP_ROOT`, package output/cache directories under it, cleans in `finally`, and verifies no package/DMG/ASAR is tracked or left in the repository.

- [ ] **Step 3: Run focused and full automated gates**

Use one root created with `mktemp -d -p /home/fiks/.cache factory-corrected-release-XXXXXX` and a shell trap. Run sequentially:

```bash
node --test patcher/tests/contract.test.js patcher/tests/patcher.test.js
node --test tests/package-hygiene.test.js tests/release-infrastructure.test.js
cargo fmt --manifest-path updater/Cargo.toml --all -- --check
cargo clippy --manifest-path updater/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path updater/Cargo.toml
make check
make test
make package-smoke VERSION=0.139.0 DIST_DIR="$TMP_ROOT/package-smoke"
FACTORY_TEST_TMP_ROOT="$TMP_ROOT/real-harness" make test-real-bundles
FACTORY_REQUIRE_CLEAN_GIT=1 make release-check
git diff --check
```

Expected: all PASS; real 0.137.0/0.138.0 rows may report explicit `SKIP (local fixture unavailable)`; raw 0.139.0 must pass when the cached official fixture exists.

### Task 10: Stage The Corrected Runtime And Preserve Rollback

**Files:**
- No repository source changes expected.
- Runtime evidence under the one bounded temporary root only.

- [ ] **Step 1: Reconfirm safety preconditions**

Verify at least 12 GiB free, installed `factory-desktop 0.139.0`, current visible stable Factory window, Droid `/health`, `allow_active=no`, and clean repository. Stop if any prerequisite fails.

- [ ] **Step 2: Rebuild the known working rollback deb from commit `33d71aa`**

Use a temporary detached worktree inside the bounded root, the accepted cached official 0.139.0 DMG, and the Phase 4 build pipeline. Inspect and checksum the rollback package; retain it until corrected installed runtime and updater E2E are complete.

- [ ] **Step 3: Build the corrected 0.139.0-linux.1 packages from current source**

Run the revision-aware release build locally inside the bounded root. Independently run `verifyReleaseBundle`, extract the deb, inspect it, verify embedded whole-bundle syntax, package version `0.139.0-1`, fixed bridge ownership/mode contract, services, and `allow_active=no`.

- [ ] **Step 4: Run staged visible-window smoke before privileged installation**

Launch the extracted `/opt/Factory/factory-desktop` as the normal user with a bounded timeout and isolated temporary `--user-data-dir` only for staged smoke. Require a visible Factory window, stable main/renderer processes, no syntax/fatal log, product-named ELF, and successful Droid health/adoption. Terminate only staged processes and preserve normal user data untouched.

### Task 11: Commit, Push, And Require Remote Green

**Files:**
- All production/tests/docs modified above.

- [ ] **Step 1: Review and commit the implementation**

Review `git diff --stat`, `git diff`, `git diff --check`, tracked generated/proprietary scan, and test logs. Commit the coherent fix without amending containment history:

```bash
git add patcher scripts tests updater .github Makefile docs release
git commit -m "fix(release): validate corrected wrapper bundles"
```

- [ ] **Step 2: Push `main` without force**

```bash
git push origin main
```

- [ ] **Step 3: Monitor CI and Package Smoke for the exact commit**

Use `gh run list`/`gh run watch` and require both workflows green. Record run URLs. A failure returns to the relevant RED→GREEN task; no workflow bypass or manual asset publication is allowed.

### Task 12: Publish And Independently Verify `v0.139.0-linux.1`

**Files:**
- No source edits expected unless a real release defect is found.

- [ ] **Step 1: Dispatch the corrected manual Release workflow**

Dispatch with exact inputs:

```text
factory_version=0.139.0
wrapper_revision=linux.1
source_ref=main
```

Require target commit equal to the pushed fix commit.

- [ ] **Step 2: Monitor every acceptance/publish job**

Do not treat uploaded workflow artifacts as a release. Require the final publish job green and the broken `v0.139.0` release still draft.

- [ ] **Step 3: Download the public corrected release into the bounded root**

Require exactly:

```text
Factory-0.139.0-linux.1-x86_64.AppImage
factory-desktop_0.139.0-1_amd64.deb
factory-desktop-0.139.0-2.x86_64.rpm
checksums.txt
build-info.json
patch-report.json
acceptance-summary.json
```

Run checksum verification, `verifyReleaseBundle`, package inspection for all formats, whole-bundle syntax inspection, provenance/source commit checks, version ordering, and confirm no DMG/ASAR/`.asc` asset.

### Task 13: Install And Verify The Corrected Baseline

**Files:**
- No repository changes expected.

- [ ] **Step 1: Reconfirm fallback and close Factory normally**

Keep the verified Phase 4 rollback deb. Request normal application quit and wait until only the exact `/opt/Factory/factory-desktop` process tree exits; do not kill unrelated Electron/Droid processes.

- [ ] **Step 2: Install only the independently downloaded public deb**

Use normal apt/dpkg privilege escalation, no force flags or script disabling. The user enters any password locally; never request or log it.

- [ ] **Step 3: Verify installation and policy**

Require package version `0.139.0-1`, `dpkg -V`, root-owned non-user-writable bridge/updater files, expected desktop/protocol/service files, embedded provenance and syntax outcome, and polkit `install-approved-package` still `allow_active=no`.

- [ ] **Step 4: Verify visible runtime**

Launch as the normal user and require a real stable window, main/renderer stability, no syntax/fatal error, Droid `/health`, daemon adoption, updater `status --json`, and preserved existing config/auth directories. If any check fails, reinstall the verified Phase 4 fallback and stop.

### Task 14: Run Native Updater E2E To Factory 0.140.0

**Files:**
- No code changes merely to force acceptance.

- [ ] **Step 1: Trigger one normal-user update check**

Confirm corrected 0.139.0 baseline and updater contracts, then run the documented updater action once. Monitor bounded transitions `idle → checking → downloading → building → validating → ready-pending-exit` or terminal failure. Do not start parallel builders.

- [ ] **Step 2: Audit the 0.140.0 candidate before promotion**

Require official exact-version HTTPS acquisition, embedded version `0.140.0`, content-addressed DMG hash, every required patch including `bundle-javascript-syntax`, validators, hygiene, package inspection, provenance/checksum, confined non-symlink candidate path, and retained rollback package.

- [ ] **Step 3: Exercise app-exit/manual privileged install only after acceptance**

Use Factory confirmation/`prepare-install`, require one after-exit helper and full Factory exit. Because `allow_active=no`, use only the documented authenticated package command. Verify package-manager version after install and relaunch exactly once only after `Installed` or verified `RolledBack`.

- [ ] **Step 4: Verify or rollback**

For accepted 0.140.0, require installed version/provenance, full-bundle syntax, visible stable runtime, Droid adoption, updater reconciliation, preserved user config, and unchanged policy. If any installed runtime check fails, install the verified corrected `0.139.0-1` public package, verify launch/version, and report rollback. If patch drift/validation fails before install, retain corrected 0.139.0 and bounded diagnostics.

### Task 15: Cleanup And Final Integrity Audit

**Files:**
- No source edits expected.

- [ ] **Step 1: Remove only bounded test/build roots**

Stop only test-specific processes, remove the single temporary root, and leave production user services and updater audit state intact. Do not delete user config, credentials, accepted candidate state, or known-good metadata needed for rollback semantics.

- [ ] **Step 2: Prove repository and policy integrity**

Require clean `git status --short`, `HEAD == origin/main`, no tracked DMG/ASAR/deb/RPM/AppImage/cache, no partial work roots, and `allow_active=no` in installed and repository policy.

- [ ] **Step 3: Produce the final Ukrainian report from authoritative evidence**

Include containment, public asset visibility, fix/root cause, syntax gate coverage, exact tests and workflow URLs, corrected release identity/assets/checksums/order, independent verification, installed baseline/runtime, 0.140.0 state transitions and verdict, after-exit/relaunch/rollback evidence actually exercised, final installed version, config preservation, cleanup, policy status, and explicit untested/residual risks. Do not label an unobserved step PASS.

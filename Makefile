SHELL := /usr/bin/env bash

.PHONY: check test test-real-bundles package-smoke lint typecheck bash-check rust-check build-app deb rpm appimage updater smoke-dmg

check: lint typecheck bash-check rust-check

test:
	@npm ci --prefix patcher --ignore-scripts >/dev/null
	@node --test patcher/tests/contract.test.js patcher/tests/patcher.test.js tests/phase1.test.js tests/package-hygiene.test.js

test-real-bundles:
	@npm ci --prefix patcher --ignore-scripts >/dev/null
	@TMP_ROOT=$$(mktemp -d -t factory-real-harness-XXXXXX); trap 'rm -rf "$$TMP_ROOT"' EXIT; FACTORY_TEST_TMP_ROOT="$$TMP_ROOT" node tests/bundle-regression/run-local.js

package-smoke:
	@npm ci --prefix patcher --ignore-scripts >/dev/null
	@node scripts/package-smoke.js "$(DIST_DIR)" "$(or $(VERSION),0.139.0)"

lint:
	@node --check scripts/phase0-check.js
	@for file in scripts/*.js; do node --check "$$file"; done
	@node --check patcher/src/contract.js

typecheck:
	@node scripts/phase0-check.js typecheck

bash-check:
	@bash -n scripts/phase0-check.sh
	@bash -n launcher/start.sh.template
	@bash -n packaging/appimage/AppRun.template
	@bash -n packaging/linux/factory-droid-daemon.sh
	@bash -n packaging/linux/factory-desktop.postinst packaging/linux/factory-desktop.prerm packaging/linux/factory-desktop.postrm

rust-check:
	@cargo fmt --manifest-path updater/Cargo.toml --all -- --check
	@cargo test --manifest-path updater/Cargo.toml

build-app:
	@npm ci --prefix patcher --ignore-scripts >/dev/null
	@node scripts/build-app.js $(if $(DMG),--dmg "$(DMG)",) $(if $(VERSION),--version "$(VERSION)",)

deb:
	@node scripts/package-deb.js "$(APP_DIR)" "$(VERSION)" "$(DIST_DIR)"

rpm:
	@node scripts/package-rpm.js "$(APP_DIR)" "$(VERSION)" "$(DIST_DIR)"

appimage:
	@node scripts/package-appimage.js "$(APP_DIR)" "$(VERSION)" "$(DIST_DIR)"

inspect-package:
	@node scripts/inspect-package.js "$(ARTIFACT)"

updater:
	@printf '%s\n' 'Phase 4 is not implemented: updater packaging is intentionally fail-closed.' >&2
	@exit 2

smoke-dmg:
	@if [[ -z "$(DMG)" ]]; then printf '%s\n' 'Usage: make smoke-dmg DMG=/absolute/path/Factory.dmg [VERSION=0.139.0]' >&2; exit 2; fi
	@npm ci --prefix patcher --ignore-scripts >/dev/null
	@node scripts/build-app.js --dmg "$(DMG)" $(if $(VERSION),--version "$(VERSION)",)

APP_DIR ?= work/latest/app
DIST_DIR ?= dist

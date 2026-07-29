SHELL := /usr/bin/env bash

.PHONY: check test test-real-bundles lint typecheck bash-check rust-check build-app deb appimage updater smoke-dmg

check: lint typecheck bash-check rust-check

test:
	@npm ci --prefix patcher --ignore-scripts >/dev/null
	@node --test patcher/tests/contract.test.js patcher/tests/patcher.test.js tests/phase1.test.js

test-real-bundles:
	@npm ci --prefix patcher --ignore-scripts >/dev/null
	@node tests/bundle-regression/run-local.js

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

appimage:
	@printf '%s\n' 'Phase 3 is not implemented: AppImage assembly is intentionally fail-closed.' >&2
	@exit 2

updater:
	@printf '%s\n' 'Phase 4 is not implemented: updater packaging is intentionally fail-closed.' >&2
	@exit 2

smoke-dmg:
	@if [[ -z "$(DMG)" ]]; then printf '%s\n' 'Usage: make smoke-dmg DMG=/absolute/path/Factory.dmg [VERSION=0.139.0]' >&2; exit 2; fi
	@npm ci --prefix patcher --ignore-scripts >/dev/null
	@node scripts/build-app.js --dmg "$(DMG)" $(if $(VERSION),--version "$(VERSION)",)

APP_DIR ?= work/latest/app
DIST_DIR ?= dist

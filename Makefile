SHELL := /usr/bin/env bash

.PHONY: check test lint typecheck bash-check rust-check build-app deb appimage updater

check: lint typecheck bash-check rust-check

test:
	@node --test patcher/tests/contract.test.js

lint:
	@node --check scripts/phase0-check.js

typecheck:
	@node scripts/phase0-check.js typecheck

bash-check:
	@bash -n scripts/phase0-check.sh

rust-check:
	@cargo fmt --manifest-path updater/Cargo.toml --all -- --check
	@cargo test --manifest-path updater/Cargo.toml

build-app:
	@printf '%s\n' 'Phase 1 is not implemented: deterministic DMG assembly is intentionally fail-closed.' >&2
	@exit 2

deb:
	@printf '%s\n' 'Phase 1/3 is not implemented: package assembly is intentionally fail-closed.' >&2
	@exit 2

appimage:
	@printf '%s\n' 'Phase 3 is not implemented: AppImage assembly is intentionally fail-closed.' >&2
	@exit 2

updater:
	@printf '%s\n' 'Phase 4 is not implemented: updater packaging is intentionally fail-closed.' >&2
	@exit 2

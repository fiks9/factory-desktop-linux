#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for path in \
  "$root/scripts/phase0-check.sh" \
  "$root/scripts/phase0-check.js"; do
  test -f "$path"
done

printf '%s\n' "Phase 0 shell contract check passed."

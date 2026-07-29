#!/usr/bin/env bash
set -euo pipefail

resolve_droid() {
  if [[ -n "${FACTORY_DROID_PATH:-}" && -x "$FACTORY_DROID_PATH" ]]; then
    printf '%s\n' "$FACTORY_DROID_PATH"
    return
  fi

  command -v droid 2>/dev/null && return
  for candidate in "$HOME/.local/bin/droid" /usr/local/bin/droid /usr/bin/droid; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

droid_path="$(resolve_droid)" || {
  printf '%s\n' 'Droid CLI not found. Install droid or set FACTORY_DROID_PATH.' >&2
  exit 1
}

help="$($droid_path daemon --help 2>&1 || true)"
args=(daemon --enable-child-ipc --droid-path "$droid_path" --host 127.0.0.1 --port 37643)
if [[ "${FACTORY_DROID_REMOTE_ACCESS:-0}" == 1 ]] && grep -q -- '--remote-access' <<<"$help"; then
  args+=(--remote-access)
fi

exec "$droid_path" "${args[@]}"

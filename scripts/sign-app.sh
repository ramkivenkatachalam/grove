#!/usr/bin/env bash
# Sign a built Grove.app with the local identity from scripts/signing-identity.sh when this Mac has one,
# otherwise ad-hoc, so a fresh clone still builds. `npm run dist` calls it.
#   scripts/sign-app.sh <path/to/Grove.app>…
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ $# -gt 0 ] || { echo "usage: $0 <Grove.app>…" >&2; exit 2; }
sha="$("$here/signing-identity.sh" --print || true)"
for app in "$@"; do
  if [ -n "$sha" ] && codesign --force --deep --sign "$sha" "$app" 2>/dev/null; then
    echo "signed $app with \"Grove Local Signing\" ($sha)"
  else
    codesign --force --deep --sign - "$app"
    if [ -n "$sha" ]; then
      echo "signed $app ad-hoc: \"Grove Local Signing\" is not usable yet (run scripts/signing-identity.sh)" >&2
    else
      echo "signed $app ad-hoc (scripts/signing-identity.sh makes privacy grants survive rebuilds)"
    fi
  fi
done

#!/usr/bin/env bash
# Give this Mac a stable code-signing identity for Grove.app: a self-signed certificate named
# "Grove Local Signing" in the login keychain. Builds signed with it keep the same designated requirement
# (bundle id + this certificate), so privacy grants such as Screen Recording survive rebuilds; ad-hoc
# builds are tied to one build's hash and lose them every time.
#   scripts/signing-identity.sh            create the identity if it is missing, and trust it for code signing
#   scripts/signing-identity.sh --print    print its SHA-1 when it exists (exit 1 when not); never creates
#   scripts/signing-identity.sh --no-trust create without the trust step (which asks for your password)
# GROVE_SIGNING_KEYCHAIN=<path> uses another keychain (tests use a throwaway one). Safe to re-run.
set -euo pipefail
NAME="Grove Local Signing"
KC="${GROVE_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
MODE=create
TRUST=1
for a in "$@"; do
  case "$a" in
    --print) MODE=print ;;
    --no-trust) TRUST=0 ;;
    -h|--help) sed -n 2,9p "$0"; exit 0 ;;
    *) echo "signing-identity: unknown option $a" >&2; exit 2 ;;
  esac
done

# the SHA-1 of the identity (certificate + private key) named $NAME, trusted or not
identity() {
  security find-identity -p codesigning "$KC" 2>/dev/null |
    awk -v n="\"$NAME\"" 'index($0, n) { print $2; exit }'
}
trusted() {
  security find-identity -v -p codesigning "$KC" 2>/dev/null | grep -qF "\"$NAME\""
}

sha="$(identity)"
if [ "$MODE" = print ]; then
  [ -n "$sha" ] && echo "$sha" || exit 1
  exit 0
fi

if [ -z "$sha" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  # /usr/bin/openssl (LibreSSL) writes a PKCS#12 that `security import` reads; OpenSSL 3+ defaults to
  # ciphers it cannot.
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$NAME" \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
    -addext "basicConstraints=critical,CA:false" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null
  pass="$(/usr/bin/openssl rand -hex 16)"
  /usr/bin/openssl pkcs12 -export -name "$NAME" -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -out "$tmp/id.p12" -passout "pass:$pass"
  # -T: codesign may use the key without a keychain prompt
  security import "$tmp/id.p12" -k "$KC" -P "$pass" -T /usr/bin/codesign >/dev/null
  sha="$(identity)"
  [ -n "$sha" ] || { echo "signing-identity: imported, but no \"$NAME\" identity shows up in $KC" >&2; exit 1; }
  echo "signing: created \"$NAME\" ($sha) in $KC"
else
  echo "signing: \"$NAME\" ($sha) is already in $KC"
fi

if [ "$TRUST" = 1 ] && ! trusted; then
  echo "signing: trusting it for code signing (macOS asks for your password once)"
  security find-certificate -c "$NAME" -p "$KC" > "${tmp:=$(mktemp -d)}/trust.pem"
  if security add-trusted-cert -r trustRoot -p codeSign -k "$KC" "$tmp/trust.pem"; then
    echo "signing: trusted"
  else
    echo "signing: not trusted (cancelled?); builds fall back to ad-hoc until you re-run $0" >&2
  fi
  rm -rf "$tmp"
fi

#!/usr/bin/env bash
# Build the patched CycleTLS sidecar used by the Claude Code fingerprint mimicry.
#
# What the patch does (against cycletls 2.0.5, gitHead 28f3d8b):
#   Stock CycleTLS unconditionally overwrites the wire `User-Agent` header with
#   the `userAgent` option value. That option ALSO selects the JA3 GREASE policy
#   ("firefox" => no GREASE, matching Claude Code's JA3). Stock behavior makes
#   an exact JA3 and a truthful `claude-cli/...` UA structurally mutually
#   exclusive -- the wire ends up as JA3-of-Claude-Code + UA "firefox", a
#   fingerprint contradiction that is easier to flag than no mimicry at all.
#   The patch keeps `userAgent` as the TLS fingerprint selector / fallback UA,
#   but no longer clobbers an explicitly provided User-Agent header.
#   Patched sites: cycletls/index.go (processRequest, dispatchHTTP3Request),
#   cycletls/roundtripper.go (RoundTrip).
#
# Usage:
#   ./scripts/build-mimic-sidecar.sh [output-dir]
#   GOOS=darwin GOARCH=arm64 ./scripts/build-mimic-sidecar.sh  # cross-compile
#
# Requires: Go >= 1.24, network access to github.com / proxy.golang.org.
set -euo pipefail

OUT_DIR="${1:-resources/cycletls-patched}"
CYCLETLS_HEAD="28f3d8b9a21470c35269fa24f3907626270ab1dc" # npm cycletls@2.0.5
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> fetching CycleTLS @ $CYCLETLS_HEAD"
git clone --quiet https://github.com/Danny-Dasilva/CycleTLS.git "$WORK/cycletls"
git -C "$WORK/cycletls" checkout --quiet "$CYCLETLS_HEAD"

echo "==> applying UA patch"
python3 - "$WORK/cycletls" <<'EOF'
import sys
root = sys.argv[1]

def patch(path, old, new, expect):
    with open(path) as f:
        s = f.read()
    n = s.count(old)
    assert n == expect, f"{path}: expected {expect} hits, found {n}"
    with open(path, "w") as f:
        f.write(s.replace(old, new))
    print(f"  patched {path} ({n} sites)")

ua_old_index = '\treq.Header.Set("user-agent", request.Options.UserAgent)'
ua_new_index = (
    '\t// Patched (opencodex internal): respect an explicitly provided User-Agent\n'
    '\t// header -- the userAgent option stays the TLS fingerprint selector and\n'
    '\t// the fallback wire UA, but no longer clobbers a deliberate spoof.\n'
    '\tif req.Header.Get("user-agent") == "" {\n'
    '\t\treq.Header.Set("user-agent", request.Options.UserAgent)\n'
    '\t}'
)
patch(f"{root}/cycletls/index.go", ua_old_index, ua_new_index, 2)

ua_old_rt = '\t// Apply user agent\n\treq.Header.Set("User-Agent", rt.UserAgent)'
ua_new_rt = (
    '\t// Patched (opencodex internal): respect an explicitly provided User-Agent\n'
    '\t// header -- the userAgent option stays the TLS fingerprint selector and\n'
    '\t// the fallback wire UA, but no longer clobbers a deliberate spoof.\n'
    '\tif req.Header.Get("User-Agent") == "" {\n'
    '\t\treq.Header.Set("User-Agent", rt.UserAgent)\n'
    '\t}'
)
patch(f"{root}/cycletls/roundtripper.go", ua_old_rt, ua_new_rt, 1)
EOF

echo "==> building (${GOOS:-$(go env GOOS)}/${GOARCH:-$(go env GOARCH)})"
mkdir -p "$OUT_DIR"
GOOS="${GOOS:-$(go env GOOS)}" GOARCH="${GOARCH:-$(go env GOARCH)}" \
  go -C "$WORK/cycletls/src" build -mod=mod -o "$OUT_DIR/cycletls-$GOOS-$GOARCH" .

echo "==> built: $OUT_DIR/cycletls-${GOOS:-$(go env GOOS)}-${GOARCH:-$(go env GOARCH)}"
echo "Verify with: JA3 must be 44f88fca027f27bab4bb08d4af15f23e and the wire"
echo "User-Agent must equal the explicitly provided claude-cli/... value."

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
#   Second patch (same files): stock CycleTLS populates the request via
#   `req.Header.Set(k, v)`, which canonicalizes every header name
#   ("x-app" -> "X-App", "anthropic-version" -> "Anthropic-Version",
#   "content-length" -> "Content-Length"). The real Claude Code CLI sends
#   mixed casing on the wire (captured; see sub2api's headerWireCasing), and
#   canonical form is itself a fingerprint signal. The patch assigns headers
#   to the map directly so the caller's exact casing reaches the wire.
#   Header-order matching (HeaderOrderKey) is case-insensitive, so ordering
#   is unaffected. Patched sites: cycletls/index.go (processRequest,
#   dispatchHTTP3Request).
#
#   Third patch (processRequest only): stock builds the HeaderOrderKey from
#   the INTERSECTION of the order list with the provided headers. fhttp
#   auto-adds canonical "Host"/"Content-Length" after the key is built, so
#   with the intersection both landed after the ordered headers (Host last,
#   CL after x-stainless-helper-method) while the real CLI sends Host first
#   and content-length second-to-last. The patch uses the full lowercased
#   order list as the key, so the case-insensitive matcher places the
#   auto-added headers at their captured positions. Remaining accepted
#   deviation: Content-Length casing (canonical vs the CLI's lowercase) --
#   unavoidable without reintroducing the duplicate-CL hazard above.
#
#   Deliberately NOT patched: dispatchWebSocketRequest / dispatchSSERequest
#   (cycletls/index.go) still canonicalize via headers.Set. Those paths are
#   dead for our transport -- the npm client only selects them via .ws() /
#   .sse(), and the mimic transport always calls client(url, options, method)
#   (protocol "" -> processRequest). If a future caller uses those methods,
#   the casing patch must be extended there too.
#
#   Trust note: the TS resolver (resolveMimicSidecarPath) trusts any existing
#   file at the bundled path or mimicSidecarPath -- there is no staleness /
#   patch-marker check. A stale UNPATCHED binary at that path would put
#   exact-JA3 + "firefox" UA on the wire. Rebuild via this script after any
#   cycletls upgrade or patch change; the python patch() assertions fail
#   loudly if upstream source drifts.
#
# Usage:
#   ./scripts/build-mimic-sidecar.sh [output-dir]
#   GOOS=darwin GOARCH=arm64 ./scripts/build-mimic-sidecar.sh  # cross-compile
#
# Requires: Go >= 1.24, network access to github.com / proxy.golang.org.
set -euo pipefail

OUT_DIR="${1:-resources/cycletls-patched}"
# Absolutize: `go -C` below changes the working directory, and a relative
# -o path would then land inside the temp work tree (deleted by the trap).
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
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

print("==> applying header-casing patch")
casing_old_1 = (
    '\t//append our normal headers\n'
    '\tfor k, v := range request.Options.Headers {\n'
    '\t\tif k != "Content-Length" {\n'
    '\t\t\treq.Header.Set(k, v)\n'
    '\t\t}\n'
    '\t}\n'
)
casing_old_2 = (
    '\t// Set headers for HTTP/3 request\n'
    '\tfor k, v := range request.Options.Headers {\n'
    '\t\tif k != "Content-Length" {\n'
    '\t\t\treq.Header.Set(k, v)\n'
    '\t\t}\n'
    '\t}\n'
)
casing_new_body = (
    '\t// Patched (opencodex internal): assign to the header map directly\n'
    '\t// instead of Header.Set, so the caller\'s exact header casing reaches\n'
    '\t// the wire (e.g. "x-app", "anthropic-version" as captured from the\n'
    '\t// real CLI). Header.Set would canonicalize to "X-App" /\n'
    '\t// "Anthropic-Version", and canonical form is itself a fingerprint signal.\n'
    '\t// HeaderOrderKey matching is\n'
    '\t// case-insensitive, so header ordering is unaffected. (Our transport\n'
    '\t// builds these keys from a case-insensitive Headers object, so\n'
    '\t// duplicate-casing entries cannot occur here.)\n'
    '\tfor k, v := range request.Options.Headers {\n'
    '\t\tif k != "Content-Length" {\n'
    '\t\t\treq.Header[k] = []string{v}\n'
    '\t\t}\n'
    '\t}\n'
)
patch(f"{root}/cycletls/index.go", casing_old_1,
      '\t//append our normal headers\n' + casing_new_body, 1)
patch(f"{root}/cycletls/index.go", casing_old_2,
      '\t// Set headers for HTTP/3 request\n' + casing_new_body, 1)

print("==> applying header-order-key patch")
order_old = (
    '\theadermap := make(map[string]string)\n'
    '\t//TODO: Shorten this\n'
    '\theaderorderkey := []string{}\n'
    '\tfor _, key := range headerorder {\n'
    '\t\tfor k, v := range request.Options.Headers {\n'
    '\t\t\tlowercasekey := strings.ToLower(k)\n'
    '\t\t\tif key == lowercasekey {\n'
    '\t\t\t\theadermap[k] = v\n'
    '\t\t\t\theaderorderkey = append(headerorderkey, lowercasekey)\n'
    '\t\t\t}\n'
    '\t\t}\n'
    '\n'
    '\t}\n'
)
order_new = (
    '\t// Patched (opencodex internal): use the full lowercased order list as\n'
    '\t// the order key instead of intersecting it with the provided headers.\n'
    '\t// fhttp auto-adds canonical "Host" and "Content-Length" AFTER this key\n'
    '\t// is built; with the full list the case-insensitive HeaderOrderKey\n'
    '\t// matcher places them at their captured positions ("host" first,\n'
    '\t// "content-length" second-to-last) instead of appending both after the\n'
    '\t// ordered headers. (headermap was write-only dead code; removed.)\n'
    '\theaderorderkey := []string{}\n'
    '\tfor _, key := range headerorder {\n'
    '\t\theaderorderkey = append(headerorderkey, key)\n'
    '\t}\n'
)
patch(f"{root}/cycletls/index.go", order_old, order_new, 1)
EOF

echo "==> building (${GOOS:-$(go env GOOS)}/${GOARCH:-$(go env GOARCH)})"
# The TS resolver (resolveMimicSidecarPath) looks up bundled binaries with
# Bun's platform/arch naming: `cycletls-${process.platform}-${process.arch}`.
# Map Go names onto that scheme so the produced file lands where the
# resolver looks (amd64->x64, windows->win32; darwin/linux/arm64 unchanged).
# NOTE: on windows the output keeps the `.exe` suffix (go appends it) --
# resolveMimicSidecarPath accepts `cycletls-win32-<arch>.exe`. Unverified on a
# real Windows host so far; the safe direction on mismatch is fail-open to
# native fetch.
PLAT="${GOOS:-$(go env GOOS)}"
ARCH="${GOARCH:-$(go env GOARCH)}"
case "$PLAT" in windows) BUN_PLAT="win32";; *) BUN_PLAT="$PLAT";; esac
case "$ARCH" in amd64) BUN_ARCH="x64";; *) BUN_ARCH="$ARCH";; esac
OUT_NAME="cycletls-$BUN_PLAT-$BUN_ARCH"
case "$PLAT" in windows) OUT_NAME="$OUT_NAME.exe";; esac
GOOS="$PLAT" GOARCH="$ARCH" \
  go -C "$WORK/cycletls/src" build -mod=mod -ldflags="-s -w" -o "$OUT_DIR/$OUT_NAME" .

echo "==> built: $OUT_DIR/$OUT_NAME"
echo "Verify with: JA3 must be 44f88fca027f27bab4bb08d4af15f23e and the wire"
echo "User-Agent must equal the explicitly provided claude-cli/... value."

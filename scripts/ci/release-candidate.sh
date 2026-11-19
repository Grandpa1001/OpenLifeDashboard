#!/usr/bin/env bash
# The candidate of a release (DEV §9.60 D61.4): the files of a release, downloaded the way a user downloads them, installed on a clean Linux. Nothing of the
# repository is used and the registry is not logged in to: the folder of the files, the package in it and the installer of the package are all there is.
#   release-candidate.sh <folder of the downloaded files> <version> [host port]
# The password of the owner comes from OPENLIFE_CANDIDATE_PASSWORD, or is made here; it is given to the installer on its standard input and never printed.
# Exits 0 only when the files are whole, the installation completes, the application answers with the version of the release and the owner signs in.
set -euo pipefail

usage() { echo "usage: release-candidate.sh <folder of the downloaded files> <version> [host port]" >&2; exit 2; }
fail() { echo "release candidate: $*" >&2; exit 1; }

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
assets="$1"
version="$2"
port="${3:-18080}"
case "$version" in
  *[!0-9.]*|''|.*|*.|*..*) usage ;;
esac
[ "$(printf '%s' "$version" | tr -cd '.' | wc -c)" -eq 2 ] || usage
[ -d "$assets" ] || fail "$assets is not a folder"
assets="$(cd "$assets" && pwd)"

owner_email="candidate@example.com"
password="${OPENLIFE_CANDIDATE_PASSWORD:-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
archive="openlife-dashboard-$version.tar.gz"
work="$(mktemp -d)"

diagnose() {
  echo "release candidate: failed; the containers of this computer follow" >&2
  docker ps --all --format '{{.Names}}  {{.Status}}' >&2 || true
  for name in $(docker ps --all --quiet --filter "name=openlife" 2>/dev/null); do docker logs --tail 40 "$name" >&2 || true; done
}
trap 'status=$?; [ "$status" -eq 0 ] || diagnose; exit "$status"' EXIT

# ---- The files: every one is listed in SHA256SUMS and matches it, and nothing else is in the folder.
[ -f "$assets/SHA256SUMS" ] || fail "SHA256SUMS is missing"
for file in "$assets"/* "$assets"/.[!.]*; do
  [ -e "$file" ] || continue
  name="$(basename "$file")"
  [ "$name" = "SHA256SUMS" ] && continue
  grep -q "^[0-9a-f]\{64\}  $name\$" "$assets/SHA256SUMS" || fail "$name is in the folder but SHA256SUMS does not list it"
done
(cd "$assets" && sha256sum --check --strict SHA256SUMS >/dev/null) || fail "a file does not match SHA256SUMS: it is damaged or was changed"
[ -f "$assets/release-manifest.json" ] || fail "release-manifest.json is missing"
grep -Eq "\"version\" *: *\"$version\"" "$assets/release-manifest.json" || fail "release-manifest.json is not the manifest of the version $version"

# ---- The package: unpacked as a user would, and the installer beside it is the very installer of the release.
[ -f "$assets/$archive" ] || fail "$archive is missing"
tar -xzf "$assets/$archive" -C "$work"
package="$work/openlife-dashboard-$version"
[ -f "$package/install.sh" ] || fail "$archive does not hold install.sh"
cmp -s "$package/install.sh" "$assets/install.sh" || fail "install.sh in the package is not the install.sh of the release"

# ---- The installation: the image is pulled by the digest of the package, the owner is made from stdin.
printf '%s\n' "$password" | bash "$package/install.sh" --dir "$work/installation" --port "$port" --owner-email "$owner_email" --owner-password-stdin --yes

curl -fsS --max-time 20 "http://127.0.0.1:$port/api/health" | grep -Eq '"status" *: *"ok"' || fail "the application does not answer ok on /api/health"
# The health answer carries no version; the container that publishes the port runs the image of the release, and that image carries its version.
container="$(docker ps --quiet --filter "publish=$port" | head -n 1)"
[ -n "$container" ] || fail "no container publishes the port $port"
reported="$(docker exec "$container" cat apps/server/package.json)" || fail "the version of the running application cannot be read"
printf '%s' "$reported" | grep -Eq "\"version\" *: *\"$version\"" || fail "the running application is not the version $version"
sign_in() {
  printf '{"email":"%s","password":"%s"}' "$owner_email" "$1" |
    curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'content-type: application/json' -H "origin: http://localhost:$port" --data-binary @- "http://127.0.0.1:$port/api/auth/sign-in/email"
}
[ "$(sign_in "${password}x")" = "401" ] || fail "a wrong password was not refused"
[ "$(sign_in "$password")" = "200" ] || fail "the owner does not sign in with the password given to the installer"

echo "release candidate: the release $version is whole, installs from its own files and the owner signs in"

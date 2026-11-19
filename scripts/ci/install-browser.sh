#!/usr/bin/env bash
# The Chromium of Playwright and the system libraries it needs, on a runner of GitHub (Analiza/CI.md). The libraries come from the mirrors of Ubuntu,
# which sometimes do not answer for minutes (run 44515723337: security.ubuntu.com unreachable, twice in a row), so the install is tried again and
# apt is told to use IPv4 only, to give up on a mirror after 20 seconds and to retry a download itself.
#   install-browser.sh with-deps   the browser and the libraries (a cache miss)
#   install-browser.sh deps-only   only the libraries (the browser came from the cache)
set -u -o pipefail

case "${1:-}" in
  with-deps) command=(pnpm exec playwright install --with-deps chromium) ;;
  deps-only) command=(pnpm exec playwright install-deps chromium) ;;
  *) echo "usage: install-browser.sh with-deps|deps-only" >&2; exit 2 ;;
esac

printf '%s\n' 'Acquire::ForceIPv4 "true";' 'Acquire::Retries "3";' 'Acquire::http::Timeout "20";' 'Acquire::https::Timeout "20";' | sudo tee "${INSTALL_BROWSER_APT_CONF:-/etc/apt/apt.conf.d/99-ci-network}" >/dev/null

for attempt in 1 2 3 4; do
  "${command[@]}" && exit 0
  echo "installing the browser (${1}) did not succeed, attempt ${attempt} of 4; trying again in 30 seconds"
  sleep "${INSTALL_BROWSER_RETRY_SECONDS:-30}"
done
exit 1

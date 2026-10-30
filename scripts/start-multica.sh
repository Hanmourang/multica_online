#!/usr/bin/env bash
# Start this checkout's named dev environment and pre-compile every module route.
#
#   scripts/start-multica.sh              # workspace slug defaults to "dev"
#   scripts/start-multica.sh hanmourang   # pre-warm another slug
#
# Why this exists instead of a bare `make up`:
#   apps/web passes `--webpack` to opt out of Turbopack (fumadocs#2658 in the
#   shared next.config). Under webpack each module route is compiled on demand
#   and costs 6~45s the first time. Worse, next's dev server restarts itself as
#   soon as the V8 heap crosses 0.8 * heap_size_limit
#   (next/dist/server/lib/start-server.js), and the per-route compile cache only
#   lives in that process — so the cache is wiped and every module falls back to
#   a cold compile. Measured on this checkout: 17 routes, 6~45s each, one heap
#   restart mid-warm; with Turbopack the same 17 routes take 0.3~2s and never
#   restart. apps/web itself does not import fumadocs (only apps/docs does), so
#   the flag is optional here; NEXT_DEV_BUNDLER picks the bundler and defaults to
#   webpack, which keeps `make up` identical for everyone else.
#
# The pre-warm step is what makes the first click fast: compilation happens here
# instead of while the user is staring at a blank page.
#
# Every probe is allowed to fail; `set -e` would abort on the first non-200
# route (e.g. a module this build does not register) instead of reporting it.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLUG="${1:-dev}"
BASE_URL="http://localhost:${FRONTEND_PORT:-13147}"
ROUTES=(
  issues my-issues projects assets agents chat calendar inbox workflows
  autopilots skills squads runtimes settings usage billing
)

# The daemon and web dev server resolve agent CLIs and node by forking the login
# shell, so a bare non-interactive bash may miss the version manager on PATH.
if ! command -v node >/dev/null 2>&1 && [ -x "$HOME/.real/.bin/node/bin/node" ]; then
  PATH="$HOME/.real/.bin/node/bin:$PATH"
  export PATH
fi

cd "$REPO_ROOT" || exit 1

BUNDLER="${NEXT_DEV_BUNDLER:-turbopack}"
echo "==> make up (web bundler: $BUNDLER)"
NEXT_DEV_BUNDLER="$BUNDLER" make up || exit 1

echo "==> pre-compiling module routes"
for route in "${ROUTES[@]}"; do
  printf '    %-12s ' "$route"
  curl -s -o /dev/null -m 120 -w '%{http_code}  %{time_total}s\n' "$BASE_URL/$SLUG/$route"
done

echo
echo "Open    $BASE_URL/$SLUG/issues"
echo "Sign in dev@localhost  ·  code 888888"
echo "Stop    cd $REPO_ROOT && make down"

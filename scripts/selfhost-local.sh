#!/usr/bin/env bash
# Build and run THIS checkout as a self-hosted stack, then prove the running
# instance actually matches it.
#
# Why this exists: `make selfhost` pulls ghcr.io/multica-ai/*:latest — the
# upstream product. This fork left upstream at migration 450 and added 44
# migrations, the asset / sprint / requirement-workflow / module-spec-center
# surfaces and nine FF_ switches on top. An instance started from the upstream
# image therefore renders a different product (upstream's "Machines / Cloud
# services" runtimes page, no fork tabs), which reads as "the deployed version
# is not the version I run locally". Two things have to be true for parity:
#
#   1. the images are built from this checkout, not pulled; and
#   2. the fork's module flags are ON, because each module is gated twice on the
#      same decision (server route registration + frontend tab visibility) and
#      a missing FF_ line removes both at once.
#
# This script enforces both, stamps the git commit into the images, and asserts
# the result through the public /api/config endpoint.
#
# Usage:
#   bash scripts/selfhost-local.sh up        # build + start + verify (default)
#   bash scripts/selfhost-local.sh verify    # assertions only, against running stack
#   bash scripts/selfhost-local.sh code      # print the latest login code from logs
#
# Environment:
#   DEV_CODE=1   also set APP_ENV=development and the fixed code 888888, so this
#                instance logs in exactly like `make up` locally. Off by default:
#                it disables the production verification-code guard, so turn it
#                on only for a private single-user box.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE="${COMPOSE:-docker compose}"
read -r -a compose_cmd <<<"$COMPOSE"
compose_files=(-f docker-compose.selfhost.yml -f docker-compose.selfhost.build.yml)

# Keep in sync with server/internal/featureflags/keys.go (frontendPublicFlags).
FORK_FLAGS=(
  FF_SPRINT_MODULE
  FF_WORKFLOW_MODULE
  FF_ASSET_MODULE
  FF_WORKFLOW_ASSET_GATE
  FF_WORKFLOW_PULL_CONTEXT
  FF_WORKFLOW_STAGE_SPEC
  FF_CHAT_CONVERSATIONS
  FF_MODULE_PROTOTYPE_CHAT
  FF_MODULE_SPEC_CENTER
)

log() { printf '==> %s\n' "$*"; }
warn() { printf '!!! %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

git_commit() {
  git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo unknown
}

git_version() {
  git -C "$ROOT_DIR" describe --tags --always --dirty 2>/dev/null || echo dev
}

# set_env KEY VALUE — rewrite in place when present, append otherwise. Handles
# BSD sed (macOS) and GNU sed without requiring `sed --version` to be parsable.
set_env() {
  local key=$1 value=$2
  if grep -qE "^${key}=" .env; then
    if sed --version >/dev/null 2>&1; then
      sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
      sed -i '' "s|^${key}=.*|${key}=${value}|" .env
    fi
  else
    printf '%s=%s\n' "$key" "$value" >>.env
  fi
}

ensure_env() {
  if [ ! -f .env ]; then
    log "Creating .env from .env.example"
    cp .env.example .env

    local jwt pgpass vcs
    jwt=$(openssl rand -hex 32)
    pgpass=$(openssl rand -hex 24)
    vcs=$(openssl rand -base64 32)
    set_env JWT_SECRET "$jwt"
    set_env POSTGRES_PASSWORD "$pgpass"
    set_env MULTICA_VCS_SECRET_KEY "$vcs"
    # Keep the local-dev connection string in sync with the rotated password.
    if sed --version >/dev/null 2>&1; then
      sed -i -E "s#^(DATABASE_URL=postgres://[^:]+:)[^@]*(@.*)#\1${pgpass}\2#" .env
    else
      sed -i '' -E "s#^(DATABASE_URL=postgres://[^:]+:)[^@]*(@.*)#\1${pgpass}\2#" .env
    fi
    log "Generated random JWT_SECRET, POSTGRES_PASSWORD and MULTICA_VCS_SECRET_KEY"
  fi

  # A .env created before the fork flags existed would silently hide every
  # fork module; append what is missing instead of demanding a manual edit.
  local flag missing=0
  for flag in "${FORK_FLAGS[@]}"; do
    if ! grep -qE "^${flag}=" .env; then
      printf '%s=true\n' "$flag" >>.env
      missing=$((missing + 1))
    fi
  done
  if [ "$missing" -gt 0 ]; then
    log "Added ${missing} missing fork module flag(s) to .env (default: true)"
  fi

  if [ "${DEV_CODE:-0}" = "1" ]; then
    set_env APP_ENV development
    set_env MULTICA_DEV_VERIFICATION_CODE 888888
    warn "DEV_CODE=1: APP_ENV=development and the fixed code 888888 are enabled — private hosts only"
  fi
}

stamp_version() {
  VERSION=$(git_version)
  COMMIT=$(git_commit)
  DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  export VERSION COMMIT DATE
}

# compose_port SERVICE CONTAINER_PORT — the host port Compose actually published.
compose_port() {
  local service=$1 port=$2 raw
  raw=$("${compose_cmd[@]}" "${compose_files[@]}" port "$service" "$port" 2>/dev/null | head -1) || true
  [ -n "$raw" ] || die "service '$service' is not running; start it with: make selfhost-local"
  printf '%s\n' "${raw##*:}"
}

email_configured() {
  local host key
  host=$(grep -E '^SMTP_HOST=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)
  key=$(grep -E '^RESEND_API_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)
  [ -n "${host:-}" ] || [ -n "${key:-}" ]
}

flag_enabled() {
  local body=$1 key=$2
  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import json, sys
try:
    cfg = json.loads(sys.argv[1])
except Exception:
    sys.exit(2)
flags = cfg.get("feature_flags") or {}
sys.exit(0 if flags.get(sys.argv[2]) is True else 1)
' "$body" "$key"
    return
  fi
  printf '%s' "$body" | grep -q "\"${key}\":true"
}

cmd_verify() {
  local backend_port frontend_port body flag key missing=() bad_image=() svc cid actual expected
  backend_port=$(compose_port backend 8080)
  frontend_port=$(compose_port frontend 3000)

  log "Checking GET /api/config for the fork's module flags"
  body=$(curl -fsS --max-time 10 "http://127.0.0.1:${backend_port}/api/config") ||
    die "backend did not answer on 127.0.0.1:${backend_port}/api/config"

  for flag in "${FORK_FLAGS[@]}"; do
    key=$(printf '%s' "$flag" | sed 's/^FF_//' | tr '[:upper:]' '[:lower:]')
    if ! flag_enabled "$body" "$key"; then
      missing+=("$key")
    fi
  done

  expected=$(git_commit)
  log "Checking that running images were built from ${expected:0:12}"
  for svc in backend frontend; do
    cid=$("${compose_cmd[@]}" "${compose_files[@]}" ps -q "$svc" 2>/dev/null | head -1)
    [ -n "$cid" ] || { bad_image+=("$svc:not-running"); continue; }
    actual=$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$cid" 2>/dev/null || true)
    if [ "${actual:-unknown}" != "$expected" ]; then
      bad_image+=("$svc:${actual:-unknown}")
    fi
  done

  if [ ${#missing[@]} -eq 0 ]; then
    log "All ${#FORK_FLAGS[@]} fork module flags are ON"
  else
    warn "Fork module flags are OFF: ${missing[*]}"
    warn "These modules are gated twice (routes + tabs), so both disappear together."
    warn "Fix: grep '^FF_' .env, set them to true, then: make selfhost-local"
  fi

  if [ ${#bad_image[@]} -eq 0 ]; then
    log "Both images are stamped with this checkout's HEAD"
  else
    warn "Image commit mismatch: ${bad_image[*]}"
    warn "A 'ghcr.io/multica-ai/*:latest' image is the upstream product, not this fork."
    warn "Fix: make selfhost-local (builds ./Dockerfile and ./Dockerfile.web)"
  fi

  if [ ${#missing[@]} -gt 0 ] || [ ${#bad_image[@]} -gt 0 ]; then
    return 1
  fi
  log "Parity check passed: http://127.0.0.1:${frontend_port}"
  return 0
}

cmd_up() {
  ensure_env
  stamp_version

  log "Building from ${ROOT_DIR} at ${VERSION} (${COMMIT:0:12})"
  "${compose_cmd[@]}" "${compose_files[@]}" up -d --build

  log "Waiting for the stack to answer /health"
  bash scripts/selfhost-wait.sh build

  if ! cmd_verify; then
    warn "Stack is running but does not match this checkout — see the messages above."
    exit 1
  fi

  local frontend_port backend_port
  frontend_port=$(compose_port frontend 3000)
  backend_port=$(compose_port backend 8080)

  cat <<EOF

==> Ready
    Web        http://127.0.0.1:${frontend_port}
    API        http://127.0.0.1:${backend_port}
    Version    ${VERSION} (${COMMIT:0:12})
    Modules    assets · sprints · requirement workflow · module spec center · DM/group chat

    Login:     an existing account works as-is. New accounts sign in with an
               email verification code.
EOF

  if [ "${DEV_CODE:-0}" = "1" ]; then
    cat <<'EOF'
               DEV_CODE=1 is on: use 888888 for any address.
EOF
  elif email_configured; then
    cat <<'EOF'
               Codes are emailed through the SMTP/Resend settings in .env.
EOF
  else
    cat <<'EOF'
               No SMTP/Resend configured, so the server prints codes instead of
               mailing them. Read the latest one with: make selfhost-code
               (or re-run with DEV_CODE=1 to pin the code to 888888)
EOF
  fi
}

cmd_code() {
  local code
  code=$("${compose_cmd[@]}" "${compose_files[@]}" logs --tail 2000 backend 2>/dev/null |
    grep -oE '\b[0-9]{6}\b' | tail -1 || true)
  if [ -z "$code" ]; then
    if email_configured; then
      die "no code in the backend log — this instance mails codes through SMTP/Resend, check that inbox"
    fi
    die "no code in the backend log yet — request one in the browser first (or use DEV_CODE=1)"
  fi
  printf '%s\n' "$code"
}

usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

case "${1:-up}" in
up) cmd_up ;;
verify) cmd_verify ;;
code) cmd_code ;;
-h | --help | help) usage ;;
*)
  usage
  exit 2
  ;;
esac

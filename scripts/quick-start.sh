#!/usr/bin/env bash
# One command for the phone channel: Go API (:18227) -> localtunnel
# (https://<subdomain>.loca.lt) -> Electron client (:5173).
#
#   scripts/quick-start.sh start             start what is down, leave the rest
#   scripts/quick-start.sh start --with-web  also the Next.js web (:13147)
#   scripts/quick-start.sh deploy            alias of `start --with-web`
#   scripts/quick-start.sh stop              stop client + tunnel
#   scripts/quick-start.sh stop --all        ... and the API
#   scripts/quick-start.sh restart [--tunnel]  client only; --tunnel recycles it
#   scripts/quick-start.sh status            what is up, and is it reachable
#   scripts/quick-start.sh logs [api|tunnel|client|web] [lines]
#
# Why a script instead of three shell commands: localtunnel must be the ONLY
# instance on the machine. Two clients asking for the same --subdomain make the
# second one fall back to a random host, and that host answers 403 to API
# callers (it wants a human to click through a warning page). So the start path
# owns "stop every other localtunnel first", and the retry loop below re-claims
# the fixed subdomain after the server has released it.
#
# State lives outside the checkout (~/.multica/dev/quick-start) so pid files and
# logs never show up in `git status` on a worktree shared with other sessions.
#
# Every probe in here is allowed to fail; `set -e` would abort on the first
# unreachable port instead of reporting it.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${MULTICA_QUICK_STATE_DIR:-$HOME/.multica/dev/quick-start}"
LOG_DIR="$STATE_DIR/logs"
SUBDOMAIN="${MULTICA_TUNNEL_SUBDOMAIN:-multica-hmr-l44}"
TUNNEL_HOST="https://$SUBDOMAIN.loca.lt"
LOCALTUNNEL_VERSION="${MULTICA_LOCALTUNNEL_VERSION:-2.0.2}"
CLIENT_PORT="${MULTICA_CLIENT_PORT:-5173}"
WEB_PORT="${MULTICA_WEB_PORT:-13147}"

mkdir -p "$LOG_DIR"

say() { printf '%s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
err() { printf '  ✗ %s\n' "$*" >&2; }

usage() {
  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------- primitives --

http_code() { # url [timeout-seconds]
  curl -s -o /dev/null -m "${2:-5}" -w '%{http_code}' "$1" 2>/dev/null || true
}

# "code:curl-exit". 000 means curl never got a response at all, and the exit
# code says why (6 DNS, 7 no route/refused, 28 timeout). Worth distinguishing: a
# dial failure heals on its own, a 502 from the edge means the client's upstream
# socket is dead and only a restart fixes it.
http_probe() { # url [timeout-seconds]
  local code
  code="$(curl -s -o /dev/null -m "${2:-5}" -w '%{http_code}' "$1" 2>/dev/null)"
  printf '%s:%s' "${code:-000}" "$?"
}

lan_ip() {
  ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
}

listen_pid() { # port
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

pid_of_file() { # pidfile
  [ -f "$1" ] && head -1 "$1" 2>/dev/null | tr -d '[:space:]' || true
}

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# Depth-first children-then-parent: killing the parent first orphans the tree
# (a `go run` wrapper leaves its compiled child holding the port).
collect_tree() { # pid
  local pid="$1" kid
  for kid in $(pgrep -P "$pid" 2>/dev/null || true); do
    collect_tree "$kid"
  done
  printf '%s\n' "$pid"
}

stop_pidfile() { # pidfile label
  local file="$1" label="$2" pid all p
  pid="$(pid_of_file "$file")"
  if ! alive "$pid"; then
    rm -f "$file"
    return 1
  fi
  all="$(collect_tree "$pid")"
  for p in $all; do kill -TERM "$p" 2>/dev/null || true; done
  for _ in $(seq 1 24); do alive "$pid" || break; sleep 0.25; done
  if alive "$pid"; then
    for p in $all; do kill -9 "$p" 2>/dev/null || true; done
  fi
  rm -f "$file"
  ok "$label stopped (pid $pid)"
  return 0
}

# localtunnel shows up as `npm exec localtunnel@2.0.2 ...`, which a
# `localtunnel --port N` pattern does not match — match the bare name instead.
tunnel_pids() { pgrep -f 'localtunnel' 2>/dev/null || true; }

tunnel_url() {
  grep -oE 'https://[a-z0-9-]+\.loca\.lt' "$LOG_DIR/tunnel.log" 2>/dev/null | tail -1 || true
}

# `.env` is the single source of truth for the port; the Makefile parses it the
# same way, so a `make api-dev` backend and this script agree on the address.
env_value() { # key default
  local key="$1" def="$2" val=""
  if [ -f "$REPO_ROOT/.env" ]; then
    val="$(grep -E "^[[:space:]]*${key}=" "$REPO_ROOT/.env" | tail -1 \
      | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
  fi
  printf '%s' "${val:-$def}"
}

PORT="$(env_value PORT "$(env_value BACKEND_PORT 18227)")"
API_URL="http://localhost:$PORT"

ensure_node() {
  if ! command -v pnpm >/dev/null 2>&1; then
    local c
    for c in "$HOME/.real/.bin/node/bin" /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
      if [ -x "$c/pnpm" ]; then
        PATH="$c:$PATH"
        export PATH
        break
      fi
    done
  fi
  local missing=()
  command -v node >/dev/null 2>&1 || missing+=(node)
  command -v pnpm >/dev/null 2>&1 || missing+=(pnpm)
  command -v npx >/dev/null 2>&1 || missing+=(npx)
  if [ ${#missing[@]} -gt 0 ]; then
    err "missing: ${missing[*]} — put the node toolchain on PATH first"
    exit 1
  fi
}

api_ready() { [ "$(http_code "$API_URL/health" 3)" = "200" ]; }

# Long-running children must not inherit this script's stdout: `start | tail`
# would hang forever waiting for EOF on a pipe that npm/electron still holds.
# </dev/null + disown + `cd` back keep the spawn detached and the pid exact
# (a subshell pid would only point at a wrapper).
spawn_detached() { # logfile pidfile workdir command...
  local log="$1" pidfile="$2" dir="$3"
  shift 3
  local prev="$PWD" pid
  cd "$dir" || return 1
  nohup "$@" >"$log" 2>&1 </dev/null &
  pid=$!
  echo "$pid" >"$pidfile"
  disown "$pid" 2>/dev/null || true
  cd "$prev" || true
  printf '%s' "$pid"
}

# ---------------------------------------------------------------- components --

start_api() {
  if api_ready; then
    ok "api already up on :$PORT — $(curl -s -m 3 "$API_URL/health" 2>/dev/null)"
    return 0
  fi
  if ! command -v go >/dev/null 2>&1; then
    err "api is down on :$PORT and \`go\` is not on PATH"
    return 1
  fi
  spawn_detached "$LOG_DIR/api.log" "$STATE_DIR/api.pid" "$REPO_ROOT" make api-dev >/dev/null
  local waited=0
  while [ "$waited" -lt 180 ]; do
    if api_ready; then
      ok "api up on :$PORT — $(curl -s -m 3 "$API_URL/health" 2>/dev/null)"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  err "api did not answer :$PORT/health within 180s — see $LOG_DIR/api.log"
  return 1
}

stop_tunnel() {
  local had=0 p pids pid
  pid="$(pid_of_file "$STATE_DIR/tunnel.pid")"
  alive "$pid" && had=1
  [ -n "$(tunnel_pids)" ] && had=1
  stop_pidfile "$STATE_DIR/tunnel.pid" "tunnel" >/dev/null 2>&1 || true
  pids="$(tunnel_pids)"
  if [ -n "$pids" ]; then
    for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
    sleep 1
    pids="$(tunnel_pids)"
    for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
  fi
  [ "$had" = 1 ] && ok "tunnel stopped"
  return 0
}

start_tunnel() {
  ensure_node
  local pids count url cycle
  pids="$(tunnel_pids)"
  if [ -n "$pids" ]; then
    count="$(printf '%s' "$pids" | grep -c . 2>/dev/null || true)"
    url="$(tunnel_url)"
    # Adoption is decided by the public route, not by the local log: a client
    # that lost its upstream socket still sits there printing "your url is:",
    # while loca.lt answers 502 for it. A url in the log proves nothing.
    if [ "${count:-0}" = "1" ] && tunnel_public_ok 2; then
      if [ "$(pid_of_file "$STATE_DIR/tunnel.pid")" = "$pids" ]; then
        ok "tunnel already up → ${url:-$TUNNEL_HOST} (pid $pids)"
      else
        ok "tunnel already up → ${url:-$TUNNEL_HOST} (pid $pids, started outside this script; stop matches by process)"
      fi
      return 0
    fi
    warn "localtunnel process(es) $(echo $pids | tr '\n' ' ') not serving $TUNNEL_HOST — recycling for a single instance"
    stop_tunnel
    # A tunnel closed a moment ago keeps its subdomain ~40s; every claim inside
    # that window lands on a random host, so sit the first one out.
    sleep 15
  fi

  for cycle in 1 2; do
    claim_tunnel || return 1
    await_tunnel_public && return 0
    [ "$cycle" = "1" ] || break
    warn "recycling the tunnel once — the edge knows $SUBDOMAIN but never reached this machine"
    stop_tunnel
    sleep 35
  done
  err "tunnel never became reachable; same wi-fi access still works — see $LOG_DIR/tunnel.log"
  return 1
}

tunnel_public_ok() { # [attempts]
  local n="${1:-1}" i=1 out
  while [ "$i" -le "$n" ]; do
    out="$(http_probe "$TUNNEL_HOST/health" 15)"
    [ "${out%%:*}" = "200" ] && return 0
    i=$((i + 1))
    [ "$i" -le "$n" ] && sleep 5
  done
  return 1
}

# Phase 1 — hold the subdomain. A wrong-host client is worse than no client:
# loca.lt hands it a random host, and that host answers 403 to API callers
# (it wants a human to click through a warning page). So only a wrong claim is
# killed, and the loop waits out the ~40s re-registration hold before retrying.
claim_tunnel() {
  local attempt url waited release_wait
  for attempt in 1 2 3; do
    : >"$LOG_DIR/tunnel.log"
    spawn_detached "$LOG_DIR/tunnel.log" "$STATE_DIR/tunnel.pid" "$REPO_ROOT" \
      npx --yes "localtunnel@$LOCALTUNNEL_VERSION" --port "$PORT" --subdomain "$SUBDOMAIN" >/dev/null
    waited=0
    url=""
    while [ "$waited" -lt 32 ]; do
      url="$(tunnel_url)"
      [ -n "$url" ] && break
      sleep 1
      waited=$((waited + 1))
    done
    if [ "$url" = "$TUNNEL_HOST" ]; then
      ok "tunnel claimed $TUNNEL_HOST"
      return 0
    fi
    warn "attempt $attempt/3 got '${url:-no url}' instead of $TUNNEL_HOST — releasing the subdomain"
    stop_tunnel
    case "$attempt" in
      1) release_wait=20 ;;
      2) release_wait=35 ;;
      *) release_wait=0 ;;
    esac
    if [ "$release_wait" -gt 0 ]; then
      warn "waiting ${release_wait}s for loca.lt to release $SUBDOMAIN (a just-closed tunnel keeps it ~40s)"
      sleep "$release_wait"
    fi
  done
  err "could not claim $SUBDOMAIN after 3 tries; another machine or a leaked client may hold it."
  err "run \`pkill -f localtunnel\`, wait ~40s, then \`scripts/quick-start.sh start --no-client\`."
  return 1
}

# Phase 2 — wait for routing. The client prints its url before loca.lt starts
# forwarding to it, so /health keeps answering 503 for a while after a good
# claim; polling is the only honest test. Never tear the tunnel down here: it
# holds the RIGHT subdomain, and letting go costs another ~40s of the hold.
await_tunnel_public() {
  local waited=0 out code rc
  while [ "$waited" -lt 90 ]; do
    out="$(http_probe "$TUNNEL_HOST/health" 15)"
    code="${out%%:*}"
    rc="${out##*:}"
    if [ "$code" = "200" ]; then
      ok "tunnel up → $TUNNEL_HOST (public /health 200)"
      return 0
    fi
    if [ "$waited" = 0 ]; then
      if [ "$code" = "000" ]; then
        warn "no route to $TUNNEL_HOST from this machine yet (curl exit $rc)"
      else
        warn "loca.lt answers $code for $SUBDOMAIN — waiting for it to route to this machine"
      fi
    fi
    sleep 5
    waited=$((waited + 5))
  done
  err "gave up after 90s: $TUNNEL_HOST answers '${code:-none}' (curl exit ${rc:-?})"
  return 1
}

start_client() {
  ensure_node
  local pid
  pid="$(listen_pid "$CLIENT_PORT")"
  if [ -n "$pid" ]; then
    ok "client already listening on :$CLIENT_PORT (pid $pid)"
    return 0
  fi
  spawn_detached "$LOG_DIR/client.log" "$STATE_DIR/client.pid" "$REPO_ROOT" pnpm dev:desktop >/dev/null
  local waited=0
  while [ "$waited" -lt 240 ]; do
    pid="$(listen_pid "$CLIENT_PORT")"
    if [ -n "$pid" ]; then
      ok "client up — renderer on :$CLIENT_PORT, window should appear shortly"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  err "client did not listen on :$CLIENT_PORT within 240s — see $LOG_DIR/client.log"
  return 1
}

start_web() {
  ensure_node
  local pid
  pid="$(listen_pid "$WEB_PORT")"
  if [ -n "$pid" ] && [ "$(http_code "http://localhost:$WEB_PORT/" 20)" = "200" ]; then
    ok "web already up on :$WEB_PORT"
    return 0
  fi
  if [ -n "$pid" ]; then
    warn "web is listening on :$WEB_PORT but not answering 200 (ENOSPC wedges Next dev) — restarting"
    stop_pidfile "$STATE_DIR/web.pid" "web" || true
    kill -TERM "$pid" 2>/dev/null || true
    sleep 3
  fi
  spawn_detached "$LOG_DIR/web.log" "$STATE_DIR/web.pid" "$REPO_ROOT" pnpm --filter @multica/web dev >/dev/null
  local waited=0
  while [ "$waited" -lt 180 ]; do
    if [ "$(http_code "http://localhost:$WEB_PORT/" 20)" = "200" ]; then
      ok "web up on :$WEB_PORT"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  err "web did not answer on :$WEB_PORT within 180s — see $LOG_DIR/web.log"
  return 1
}

stop_client() {
  local had=0 pid p
  pid="$(pid_of_file "$STATE_DIR/client.pid")"
  alive "$pid" && had=1
  [ -n "$(listen_pid "$CLIENT_PORT")" ] && had=1
  [ -n "$(pgrep -f 'electron-vite' 2>/dev/null || true)" ] && had=1
  stop_pidfile "$STATE_DIR/client.pid" "client" >/dev/null 2>&1 || true
  # A client started outside this script has no pid file; the ports are the
  # proof. Stop whatever holds the renderer port and its electron-vite parent.
  pid="$(listen_pid "$CLIENT_PORT")"
  if [ -n "$pid" ]; then
    for p in $(collect_tree "$pid"); do kill -TERM "$p" 2>/dev/null || true; done
  fi
  for p in $(pgrep -f 'electron-vite' 2>/dev/null || true); do kill -TERM "$p" 2>/dev/null || true; done
  for p in $(pgrep -f 'dev\.mjs' 2>/dev/null || true); do kill -TERM "$p" 2>/dev/null || true; done
  sleep 2
  if [ -n "$(listen_pid "$CLIENT_PORT")" ]; then
    for p in $(pgrep -f 'electron-vite' 2>/dev/null || true); do kill -9 "$p" 2>/dev/null || true; done
  fi
  [ "$had" = 1 ] && ok "client stopped"
  return 0
}

# ------------------------------------------------------------------ commands --

cmd_start() {
  local with_web=0 no_api=0 no_tunnel=0 no_client=0 a
  for a in "$@"; do
    case "$a" in
      --with-web) with_web=1 ;;
      --no-api) no_api=1 ;;
      --no-tunnel) no_tunnel=1 ;;
      --no-client) no_client=1 ;;
      *) err "unknown flag: $a"; usage; exit 2 ;;
    esac
  done

  say "multica quick-start  (repo $REPO_ROOT)"
  local failed=0
  if [ "$no_api" = 0 ]; then start_api || failed=1; else warn "api skipped (--no-api)"; fi
  if [ "$with_web" = 1 ]; then start_web || failed=1; fi
  if [ "$no_tunnel" = 0 ]; then start_tunnel || failed=1; else warn "tunnel skipped (--no-tunnel)"; fi
  if [ "$no_client" = 0 ]; then start_client || failed=1; else warn "client skipped (--no-client)"; fi
  say ""
  cmd_status
  return "$failed"
}

stop_api() {
  if stop_pidfile "$STATE_DIR/api.pid" "api"; then return 0; fi
  local pid p
  pid="$(listen_pid "$PORT")"
  if [ -z "$pid" ]; then
    warn "api not running on :$PORT"
    return 1
  fi
  # `go run` keeps the compiled binary as a child; kill the tree or the port
  # stays taken by a process this script can no longer name.
  for p in $(collect_tree "$pid"); do kill -TERM "$p" 2>/dev/null || true; done
  ok "api stopped (pid $pid, started outside this script)"
  return 0
}

cmd_stop() {
  local with_all=0 a
  for a in "$@"; do
    case "$a" in
      --all) with_all=1 ;;
      *) err "unknown flag: $a"; usage; exit 2 ;;
    esac
  done
  say "multica quick-stop"
  stop_client
  stop_tunnel
  if [ "$with_all" = 1 ]; then
    stop_api || true
  else
    warn "api left running on :$PORT (use --all to stop it too)"
  fi
  return 0
}

cmd_restart() {
  # Restarting the renderer is what "restart" usually means, so the tunnel is
  # kept by default: tearing down a healthy one makes loca.lt hold the
  # subdomain ~40s, and the next claim lands on a random host that answers 403
  # to API callers. `--tunnel` opts into that churn when the tunnel itself is
  # the thing being debugged.
  local with_tunnel=0 with_all=0 start_extra="" a
  for a in "$@"; do
    case "$a" in
      --tunnel) with_tunnel=1 ;;
      --all) with_all=1 ;;
      --with-web | --no-api | --no-tunnel | --no-client) start_extra="$start_extra $a" ;;
      *)
        err "unknown flag: $a"
        usage
        exit 2
        ;;
    esac
  done
  say "multica quick-restart"
  [ "$with_tunnel" = 1 ] && stop_tunnel
  stop_client
  [ "$with_all" = 1 ] && stop_api
  sleep 3
  cmd_start $start_extra
}

cmd_status() {
  local code pid ip
  say "── status ─────────────────────────────────────────────"
  printf '  api       :%s  ' "$PORT"
  code="$(http_code "$API_URL/health" 4)"
  if [ "$code" = "200" ]; then
    printf 'up    %s\n' "$(curl -s -m 4 "$API_URL/health" 2>/dev/null)"
  else
    printf 'down  (http %s)\n' "${code:-none}"
  fi

  printf '  web       :%s  ' "$WEB_PORT"
  code="$(http_code "http://localhost:$WEB_PORT/" 8)"
  printf 'http %s\n' "${code:-none}"

  printf '  client    :%s  ' "$CLIENT_PORT"
  pid="$(listen_pid "$CLIENT_PORT")"
  if [ -n "$pid" ]; then printf 'up (pid %s)\n' "$pid"; else printf 'down\n'; fi

  ip="$(lan_ip)"
  printf '  lan ip    %s\n' "${ip:-none}"

  # One probe for the whole block: a blocked or dead host costs 15s each time,
  # and calling it twice just doubles the wait before the report appears.
  printf '  tunnel    '
  local pids count url out tcode trc
  pids="$(tunnel_pids)"
  count="$(printf '%s' "$pids" | grep -c . 2>/dev/null || true)"
  out="$(http_probe "$TUNNEL_HOST/health" 15)"
  tcode="${out%%:*}"
  trc="${out##*:}"
  if [ "${count:-0}" = "0" ]; then
    printf 'down (no process; public host answers %s)\n' "$tcode"
  else
    url="$(tunnel_url)"
    if [ -z "$url" ]; then
      [ "$tcode" = "200" ] && url="$TUNNEL_HOST (claimed, no log — started outside this script)" \
        || url="unknown (no log; public host answers $tcode)"
    fi
    printf '%s process(es) → %s\n' "$count" "$url"
    case "$tcode" in
      200) printf '            public /health 200 (reachable)\n' ;;
      000) printf '            public /health 000 — no route from this machine (curl exit %s)\n' "$trc" ;;
      502 | 503 | 504)
        printf '            public /health %s — edge has the subdomain but not this client; rerun `start`\n' "$tcode"
        ;;
      *) printf '            public /health %s\n' "$tcode" ;;
    esac
    [ "${count:-0}" -gt 1 ] && warn "more than one localtunnel is running — random host + 403 risk"
  fi

  say ""
  if [ "$tcode" = "200" ]; then
    say "  phone app → server  https://$SUBDOMAIN.loca.lt"
    say "              ws      wss://$SUBDOMAIN.loca.lt/ws   (HTTP ok; WS upgrade is blocked by loca.lt)"
  fi
  [ -n "$ip" ] && say "  same wi-fi → server  http://$ip:$PORT   ws ws://$ip:$PORT/ws"
  say "  logs      $LOG_DIR"
}

cmd_logs() {
  local which="${1:-client}" n="${2:-80}" f
  case "$which" in
    api | tunnel | client | web) f="$LOG_DIR/$which.log" ;;
    *) err "unknown log: $which (api|tunnel|client|web)"; exit 2 ;;
  esac
  [ -f "$f" ] || {
    err "no log yet: $f"
    exit 1
  }
  tail -n "$n" "$f"
}

# ---------------------------------------------------------------------- main --

verb="${1:-}"
[ $# -gt 0 ] && shift || true
case "$verb" in
  start) cmd_start "$@" ;;
  deploy) cmd_start --with-web "$@" ;;
  stop) cmd_stop "$@" ;;
  restart) cmd_restart "$@" ;;
  status) cmd_status ;;
  logs) cmd_logs "$@" ;;
  "" | -h | --help | help) usage ;;
  *)
    err "unknown command: $verb"
    usage
    exit 2
    ;;
esac

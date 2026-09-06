#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$REPO_ROOT/organizer/compose.test.yaml"
PROJECT_NAME="immich-organizer-runtime-test"
LOCAL_BACKEND="http://127.0.0.1:18283"
NAS_BACKEND="http://192.168.4.81:2283"
FRONTEND_URL="http://127.0.0.1:3000/organize"
STATE_DIR="${TMPDIR:-/tmp}/immich-organizer-dev"
PID_FILE="$STATE_DIR/vite.pid"
MODE_FILE="$STATE_DIR/backend-mode"

COMMAND=start
BACKEND_URL="${IMMICH_SERVER_URL:-$LOCAL_BACKEND}"
MODE=local
REBUILD=0
PNPM_MODE=

usage() {
  cat <<'EOF'
Usage: ./scripts/organizer-dev.sh [start|status|check|stop] [options]

Commands:
  start       Validate and start the synthetic stack, then run Vite (default).
  check       Validate the selected backend target and local Compose syntax.
  status      Show the selected backend, Vite PID, Compose state, and ping result.
  stop        Stop this harness's Vite process and its synthetic Compose project.

Options:
  --rebuild-backend       Rebuild the local server and worker images before start.
  --nas                   Explicitly proxy Vite to the NAS Immich URL; no Compose.
  --unsafe-backend URL    Explicitly proxy Vite to another backend; no Compose.
  --help                  Show this help.

The default backend is http://127.0.0.1:18283. Non-loopback targets require an
explicit --nas or --unsafe-backend option.
EOF
}

die() {
  printf '%s\n' "organizer-dev: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    start|status|check|stop)
      COMMAND=$1
      ;;
    --rebuild-backend)
      REBUILD=1
      ;;
    --nas)
      [ "$MODE" = local ] || die "--nas cannot be combined with another remote backend"
      MODE=nas
      BACKEND_URL=$NAS_BACKEND
      ;;
    --unsafe-backend)
      [ "$#" -ge 2 ] || die "--unsafe-backend requires a URL"
      [ "$MODE" = local ] || die "--unsafe-backend cannot be combined with --nas"
      MODE=remote
      BACKEND_URL=$2
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument '$1' (use --help)"
      ;;
  esac
  shift
done

[ -f "$COMPOSE_FILE" ] || die "missing synthetic Compose file: $COMPOSE_FILE"

case "$BACKEND_URL" in
  http://*|https://*) ;;
  *) die "backend must be an http:// or https:// URL" ;;
esac

case "$BACKEND_URL" in
  "$LOCAL_BACKEND"|http://localhost:18283)
    [ "$MODE" = local ] || die "a local backend cannot be selected with a remote option"
    ;;
  *)
    [ "$MODE" != local ] || die "refusing non-loopback IMMICH_SERVER_URL; use --nas or --unsafe-backend explicitly"
    ;;
esac

[ "$MODE" = local ] || [ "$REBUILD" -eq 0 ] || die "--rebuild-backend is available only for the local synthetic stack"

compose() {
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
}

check_commands() {
  command -v curl >/dev/null 2>&1 || die "curl is required"
  if command -v pnpm >/dev/null 2>&1; then
    PNPM_MODE=native
  elif command -v npx >/dev/null 2>&1; then
    PNPM_MODE=npx
  else
    die "pnpm or npx is required"
  fi
  if [ "$MODE" = local ]; then
    command -v docker >/dev/null 2>&1 || die "Docker is required for the local synthetic stack"
  fi
}

pnpm_exec() {
  if [ "$PNPM_MODE" = native ]; then
    pnpm "$@"
  else
    npx --yes pnpm@11.13.1 "$@"
  fi
}

check_config() {
  check_commands
  if [ "$MODE" = local ]; then
    compose config --quiet --no-interpolate || die "synthetic Compose configuration is invalid"
  fi
}

ping_backend() {
  curl -fsS --connect-timeout 2 --max-time 5 "$BACKEND_URL/api/server/ping" >/dev/null 2>&1
}

wait_for_backend() {
  attempt=0
  while [ "$attempt" -lt 90 ]; do
    if ping_backend; then
      printf '%s\n' "organizer-dev: backend is ready at $BACKEND_URL"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  if [ "$MODE" = local ]; then
    compose ps || true
  fi
  die "backend did not answer /api/server/ping within 90 seconds"
}

read_pid() {
  [ -s "$PID_FILE" ] || return 1
  pid=$(tr -d '[:space:]' < "$PID_FILE")
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$pid"
}

is_our_vite_pid() {
  pid=$1
  command_line=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$command_line" in
    *vite*"--host 127.0.0.1"*"--port 3000"*) return 0 ;;
    *) return 1 ;;
  esac
}

running_vite_pid() {
  pid=$(read_pid) || return 1
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    return 1
  fi
  is_our_vite_pid "$pid" || return 2
  printf '%s\n' "$pid"
}

write_mode() {
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$MODE" > "$MODE_FILE"
}

stored_mode() {
  [ -s "$MODE_FILE" ] || return 1
  tr -d '[:space:]' < "$MODE_FILE"
}

stop_vite() {
  pid=
  if pid=$(running_vite_pid); then
    :
  else
    pid_status=$?
    [ "$pid_status" -eq 1 ] && return 0
    die "PID file does not identify this harness's Vite process; refusing to stop it"
  fi
  kill -TERM "$pid" 2>/dev/null || true
  attempt=0
  while kill -0 "$pid" 2>/dev/null && [ "$attempt" -lt 10 ]; do
    sleep 1
    attempt=$((attempt + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "organizer-dev: Vite did not exit after SIGTERM; leaving it running"
  else
    rm -f "$PID_FILE"
  fi
}

wait_for_vite() {
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if curl -fsS --connect-timeout 2 --max-time 5 "$FRONTEND_URL" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$vite_pid" 2>/dev/null; then
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
}

print_login() {
  cat <<'EOF'

Synthetic local Immich login
  email:    organizer-test@example.invalid
  password: Synthetic-local-test-password!
EOF
}

start_vite() {
  existing_pid=
  if existing_pid=$(running_vite_pid); then
    die "this harness already has Vite running (PID $existing_pid); use status or stop"
  else
    pid_status=$?
    [ "$pid_status" -eq 1 ] || die "PID file does not identify this harness's Vite process; refusing to start"
  fi
  if curl -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:3000/ >/dev/null 2>&1; then
    die "127.0.0.1:3000 is already in use; refusing to stop another process"
  fi
  mkdir -p "$STATE_DIR"
  (
    cd "$REPO_ROOT"
    export IMMICH_SERVER_URL="$BACKEND_URL"
    pnpm_exec --filter immich-web exec vite dev --host 127.0.0.1 --port 3000 --strictPort
  ) &
  vite_pid=$!
  printf '%s\n' "$vite_pid" > "$PID_FILE"
  if ! wait_for_vite; then
    stop_vite
    die "Vite did not answer at $FRONTEND_URL"
  fi
  printf '%s\n' "organizer-dev: Vite is ready at $FRONTEND_URL"
  if [ "$(uname -s 2>/dev/null || true)" = Darwin ] && command -v open >/dev/null 2>&1; then
    open "$FRONTEND_URL" >/dev/null 2>&1 || true
  fi
  if [ "$MODE" = local ]; then
    print_login
  else
    printf '%s\n' "organizer-dev: use an existing NAS Immich account; synthetic local credentials do not apply"
  fi
  printf '%s\n' "organizer-dev: hot reload is active; Ctrl-C stops Vite, while the synthetic stack stays available"
  trap 'stop_vite; exit 130' INT TERM
  wait "$vite_pid" || true
  rm -f "$PID_FILE"
}

start() {
  check_config
  if [ "$MODE" = local ]; then
    if [ "$REBUILD" -eq 1 ]; then
      printf '%s\n' "organizer-dev: rebuilding local server and worker images"
      (cd "$REPO_ROOT" && docker build -f organizer/Dockerfile -t immich-organizer-worker:test .)
      (cd "$REPO_ROOT" && docker build -f organizer/server.Dockerfile -t immich-organizer-server:test .)
    fi
    compose up -d
  else
    printf '%s\n' "organizer-dev: WARNING --$MODE proxies UI requests to $BACKEND_URL"
    printf '%s\n' "organizer-dev: no local Compose services are started and no Organizer settings are changed"
  fi
  write_mode
  wait_for_backend
  start_vite
}

status() {
  check_config
  printf '%s\n' "organizer-dev: mode=$MODE backend=$BACKEND_URL frontend=$FRONTEND_URL"
  if [ "$MODE" = local ]; then
    compose ps
  fi
  if pid=$(running_vite_pid); then
    printf '%s\n' "organizer-dev: Vite PID $pid is running"
  elif [ "$?" -eq 2 ]; then
    printf '%s\n' "organizer-dev: a PID file belongs to another process; no process was stopped"
  else
    printf '%s\n' "organizer-dev: Vite is not running"
  fi
  if ping_backend; then
    printf '%s\n' "organizer-dev: backend ping OK"
  else
    printf '%s\n' "organizer-dev: backend ping unavailable"
    return 1
  fi
}

stop() {
  check_commands
  stop_vite
  mode=$(stored_mode || true)
  if [ "$MODE" = local ] && [ "$mode" = local ]; then
    compose down
    printf '%s\n' "organizer-dev: stopped only this harness's Vite process and synthetic Compose project"
  else
    printf '%s\n' "organizer-dev: stopped only this harness's Vite process; no remote or unrelated process was touched"
  fi
  rm -f "$MODE_FILE"
}

case "$COMMAND" in
  start) start ;;
  check) check_config; printf '%s\n' "organizer-dev: configuration OK (mode=$MODE backend=$BACKEND_URL)" ;;
  status) status ;;
  stop) stop ;;
esac

#!/usr/bin/env bash
# claude-threads-install.sh — install / snapshot / rollback the claude-threads bot.
#
# The bot runs from a source checkout, not a global npm install. This script
# manages that checkout, takes timestamped snapshots of the built `dist/`
# before every install, and lets you roll back to any prior snapshot.
#
# Snapshots NEVER touch your user state (~/.config/claude-threads/config.yaml,
# ~/.config/claude-threads/sessions.json, ~/.claude-threads/logs/...). They
# only capture the bot binary (`dist/`), the lockfile, and the git ref so
# rebuilds are reproducible.
#
# Usage:
#   claude-threads-install install [ref]    # install/upgrade to a git ref
#   claude-threads-install setup            # interactive config wizard (tokens, channels)
#   claude-threads-install rollback [label] # default: most recent snapshot
#   claude-threads-install snapshot [label] # take a manual snapshot now
#   claude-threads-install list             # newest snapshots first
#   claude-threads-install status           # what's running + what's checked out
#
# Env overrides:
#   CLAUDE_THREADS_REPO          path to the source checkout
#   CLAUDE_THREADS_SNAPSHOTS     where to store snapshot tarballs
#   CLAUDE_THREADS_DEFAULT_REF   default git ref for `install`

set -euo pipefail

REPO="${CLAUDE_THREADS_REPO:-$HOME/code/claude-threads-agent}"
SNAPSHOTS="${CLAUDE_THREADS_SNAPSHOTS:-$HOME/.claude-threads-snapshots}"
DEFAULT_REF="${CLAUDE_THREADS_DEFAULT_REF:-claude/thread-spawn-and-channel-replies}"

DAEMON_BIN="$REPO/bin/claude-threads-daemon"
DAEMON_ARGS=(--restart-on-error --no-auto-restart)
DAEMON_PATTERN="claude-threads-daemon"
NODE_PATTERN="claude-threads-agent/dist/index.js"

# macOS `pgrep -f` is unreliable for matching full command lines (BSD pgrep
# only looks at the executable name + first arg in some setups). Use a
# ps-based fallback that works on both macOS and Linux.
pids_matching() {
  local pattern="$1"
  ps -ax -o pid,args 2>/dev/null | awk -v p="$pattern" '$0 ~ p && !/awk/ && !/grep/ { print $1 }'
}

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
log()  { printf '%s[ct] %s%s\n' "$BLUE"   "$*" "$RESET" >&2; }
ok()   { printf '%s[ct] ✓ %s%s\n' "$GREEN" "$*" "$RESET" >&2; }
warn() { printf '%s[ct] ⚠ %s%s\n' "$YELLOW" "$*" "$RESET" >&2; }
die()  { printf '%s[ct] ✗ %s%s\n' "$RED"  "$*" "$RESET" >&2; exit 1; }

require_repo() { [[ -d "$REPO/.git" ]] || die "repo not found at $REPO (set CLAUDE_THREADS_REPO)"; }

repo_pkg_version() {
  node -e "console.log(require('$REPO/package.json').version)" 2>/dev/null || echo "unknown"
}

repo_ref() {
  git -C "$REPO" symbolic-ref --short HEAD 2>/dev/null || echo "(detached)"
}

repo_sha_short() {
  git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo "unknown"
}

# Build a label like "20260528-2347-v1.0-30c7e74". Used as the snapshot dir name.
snapshot_label() {
  local ts ref sha
  ts=$(date +%Y%m%d-%H%M%S)
  ref=$(repo_ref)
  sha=$(repo_sha_short)
  # Sanitize ref for filesystem.
  ref=${ref//\//-}
  ref=${ref//(/}; ref=${ref//)/}; ref=${ref// /-}
  echo "${ts}-${ref}-${sha}"
}

cmd_status() {
  require_repo
  local pids; pids=$(pids_matching "$DAEMON_PATTERN" | tr '\n' ' ')
  if [[ -n "$pids" ]]; then
    ok "daemon running (pids:$pids)"
  else
    warn "daemon not running"
  fi
  log "source: $REPO @ $(repo_ref) ($(repo_sha_short))"
  log "package version: $(repo_pkg_version)"
  log "snapshots dir: $SNAPSHOTS"
  if [[ -d "$REPO/dist" ]]; then
    local size; size=$(du -sh "$REPO/dist" 2>/dev/null | awk '{print $1}')
    log "dist/ present ($size)"
  else
    warn "no dist/ — nothing built yet"
  fi
}

cmd_snapshot() {
  require_repo
  [[ -d "$REPO/dist" ]] || die "no dist/ to snapshot — run a build first"
  local label="${1:-}"
  [[ -z "$label" ]] && label=$(snapshot_label)
  local out="$SNAPSHOTS/$label"
  if [[ -e "$out" ]]; then
    die "snapshot already exists: $out"
  fi
  mkdir -p "$out"
  log "snapshotting current build → $label"
  tar -czf "$out/dist.tar.gz" -C "$REPO" dist
  cp "$REPO/package.json" "$out/package.json"
  [[ -f "$REPO/bun.lock" ]]         && cp "$REPO/bun.lock"         "$out/bun.lock"         || true
  [[ -f "$REPO/package-lock.json" ]] && cp "$REPO/package-lock.json" "$out/package-lock.json" || true
  {
    echo "label=$label"
    echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "git_ref=$(repo_ref)"
    echo "git_sha=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "package_version=$(repo_pkg_version)"
  } > "$out/meta"
  ok "saved → $out"
  printf '%s\n' "$label"
}

cmd_list() {
  if [[ ! -d "$SNAPSHOTS" ]] || [[ -z "$(ls -A "$SNAPSHOTS" 2>/dev/null)" ]]; then
    warn "no snapshots yet"
    return
  fi
  log "available snapshots (newest first):"
  # ls -1t sorts newest first
  while IFS= read -r d; do
    [[ -d "$SNAPSHOTS/$d" ]] || continue
    local meta="$SNAPSHOTS/$d/meta"
    local ver="?" gref="?"
    if [[ -f "$meta" ]]; then
      ver=$(grep '^package_version=' "$meta"  | cut -d= -f2-)
      gref=$(grep '^git_ref='          "$meta" | cut -d= -f2-)
    fi
    printf '  %s  (v%s, %s)\n' "$d" "$ver" "$gref"
  done < <(ls -1t "$SNAPSHOTS" 2>/dev/null)
}

kill_matching() {
  local pattern="$1"
  local signal="${2:-TERM}"
  local pids; pids=$(pids_matching "$pattern" | tr '\n' ' ')
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -"$signal" $pids 2>/dev/null || true
  fi
}

stop_bot() {
  log "stopping bot..."
  # Kill node first (the actual process), then the daemon wrapper.
  kill_matching "$NODE_PATTERN"   TERM
  kill_matching "$DAEMON_PATTERN" TERM
  sleep 1
  # Force if any survived.
  local survivors; survivors=$(pids_matching "$DAEMON_PATTERN")
  if [[ -n "$survivors" ]]; then
    warn "daemon survived SIGTERM, sending SIGKILL"
    kill_matching "$DAEMON_PATTERN" KILL
    kill_matching "$NODE_PATTERN"   KILL
    sleep 1
  fi
}

start_bot() {
  require_repo
  [[ -x "$DAEMON_BIN" ]] || die "daemon not executable: $DAEMON_BIN"
  log "starting bot..."
  export CLAUDE_THREADS_BIN="$REPO/dist/index.js"
  # Unset CLAUDE_THREADS_INTERACTIVE so the bot auto-detects headless mode
  # when running without a TTY (daemon background mode)
  unset CLAUDE_THREADS_INTERACTIVE
  ( cd "$REPO" && nohup "$DAEMON_BIN" "${DAEMON_ARGS[@]}" >/dev/null 2>&1 & disown ) || true
  sleep 2
  local pids; pids=$(pids_matching "$DAEMON_PATTERN")
  if [[ -n "$pids" ]]; then
    ok "bot started (v$(repo_pkg_version), $(repo_ref))"
  else
    die "bot did not start — check ~/.config/claude-threads or run \`bun start\` from $REPO to debug"
  fi
}

cmd_rollback() {
  require_repo
  [[ -d "$SNAPSHOTS" ]] || die "no snapshots dir"
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    target=$(ls -1t "$SNAPSHOTS" 2>/dev/null | head -1) || true
    [[ -n "$target" ]] || die "no snapshots available"
  fi
  local src="$SNAPSHOTS/$target"
  [[ -d "$src" ]] || die "no such snapshot: $target"
  [[ -f "$src/dist.tar.gz" ]] || die "snapshot is missing dist.tar.gz: $src"
  log "rolling back to: $target"
  # Take a defensive snapshot of the CURRENT build before clobbering it.
  if [[ -d "$REPO/dist" ]]; then
    cmd_snapshot "pre-rollback-$(date +%Y%m%d-%H%M%S)" >/dev/null
  fi
  stop_bot
  rm -rf "$REPO/dist"
  tar -xzf "$src/dist.tar.gz" -C "$REPO"
  start_bot
  ok "rolled back to $target"
}

cmd_start()   { start_bot; }
cmd_stop()    { stop_bot; ok "bot stopped"; }
cmd_restart() { stop_bot; start_bot; }

cmd_panel() {
  local url="http://127.0.0.1:7777"
  log "dashboard: $url"
  if command -v open >/dev/null 2>&1; then open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url"
  fi
}

cmd_setup() {
  require_repo
  command -v bun >/dev/null 2>&1 || die "bun not found — install from https://bun.sh"
  # The wizard is interactive; when stdin is not a TTY (curl | bash), attach
  # the terminal directly so prompts work.
  if [[ -t 0 ]]; then
    ( cd "$REPO" && bun scripts/setup.ts "$@" )
  elif [[ -e /dev/tty ]]; then
    ( cd "$REPO" && bun scripts/setup.ts "$@" </dev/tty >/dev/tty 2>&1 )
  else
    die "no TTY available — run \`claude-threads-install.sh setup\` from a terminal"
  fi
}

cmd_install() {
  require_repo
  local ref="${1:-$DEFAULT_REF}"
  log "installing claude-threads @ $ref (current: $(repo_ref) v$(repo_pkg_version))"
  if [[ -d "$REPO/dist" ]]; then
    cmd_snapshot "" >/dev/null
  else
    warn "no dist/ yet — nothing to snapshot"
  fi
  log "fetching origin..."
  git -C "$REPO" fetch --all --prune
  log "checkout $ref..."
  git -C "$REPO" checkout "$ref"
  # ff-only pull if the ref is a local branch tracking a remote.
  git -C "$REPO" pull --ff-only 2>/dev/null || true
  log "installing deps (bun)..."
  ( cd "$REPO" && bun install )
  log "building..."
  ( cd "$REPO" && bun run build )
  stop_bot
  start_bot
  ok "installed @ $ref (v$(repo_pkg_version))"
}

usage() {
  cat <<EOF
usage: $(basename "$0") <command> [args]

commands:
  install [ref]      install/upgrade to a git ref (default: $DEFAULT_REF)
                     auto-snapshots current build before clobbering
  setup              interactive config wizard (platforms, tokens, channels)
  start | stop | restart   control the daemon without rebuilding
  panel              open the agent dashboard (http://127.0.0.1:7777)
  rollback [label]   restore a snapshot (default: latest)
  snapshot [label]   manually snapshot current dist/
  list               list snapshots, newest first
  status             show daemon, source ref, version

env overrides (current values shown):
  CLAUDE_THREADS_REPO          = $REPO
  CLAUDE_THREADS_SNAPSHOTS     = $SNAPSHOTS
  CLAUDE_THREADS_DEFAULT_REF   = $DEFAULT_REF

examples:
  $(basename "$0") install              # install v1.0 (default)
  $(basename "$0") install main         # roll forward to whatever's on main
  $(basename "$0") install v1.0         # explicit
  $(basename "$0") rollback             # back to last snapshot
  $(basename "$0") list                 # see what you have
EOF
}

main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    install)              cmd_install  "$@" ;;
    setup|onboard)         cmd_setup    "$@" ;;
    start)                 cmd_start ;;
    stop)                  cmd_stop ;;
    restart)               cmd_restart ;;
    panel|dashboard|ui)    cmd_panel ;;
    rollback|revert)      cmd_rollback "$@" ;;
    snapshot|snap)        cmd_snapshot "$@" ;;
    list|ls)              cmd_list ;;
    status|st)            cmd_status ;;
    -h|--help|help|"")    usage ;;
    *) usage; exit 2 ;;
  esac
}

main "$@"

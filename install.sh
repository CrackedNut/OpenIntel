#!/usr/bin/env bash
# claude-threads one-liner installer — get a chat-driven Claude Code agent
# running on a fresh machine:
#
#   curl -fsSL https://raw.githubusercontent.com/CrackedNut/claude-threads-agent/main/install.sh | bash
#
# What it does:
#   1. Installs bun if missing (git must already exist)
#   2. Clones the repo to ~/code/claude-threads-agent (or updates it)
#   3. Builds, installs the `claude-threads-install.sh` manager to ~/bin
#   4. Runs the interactive config wizard (platforms, bot tokens, channels)
#      if no config exists yet
#   5. Starts the bot daemon and prints the dashboard URL
#
# Env overrides:
#   CLAUDE_THREADS_REPO_SLUG  github slug          (default: CrackedNut/claude-threads-agent)
#   CLAUDE_THREADS_REF        branch/tag to run    (default: main)
#   CLAUDE_THREADS_REPO       checkout path        (default: ~/code/claude-threads-agent)
#   GITHUB_TOKEN              for private forks
#   CLAUDE_THREADS_NO_START   set 1 to skip starting the daemon

set -euo pipefail

SLUG="${CLAUDE_THREADS_REPO_SLUG:-CrackedNut/claude-threads-agent}"
REF="${CLAUDE_THREADS_REF:-main}"
DEST="${CLAUDE_THREADS_REPO:-$HOME/code/claude-threads-agent}"
BIN_DIR="$HOME/bin"
CONFIG="$HOME/.config/claude-threads/config.yaml"

BLUE=$'\033[34m'; GREEN=$'\033[32m'; RED=$'\033[31m'; RESET=$'\033[0m'
log() { printf '%s[install] %s%s\n' "$BLUE" "$*" "$RESET" >&2; }
ok()  { printf '%s[install] ✓ %s%s\n' "$GREEN" "$*" "$RESET" >&2; }
die() { printf '%s[install] ✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------
command -v git >/dev/null 2>&1 || die "git is required — install it first (xcode-select --install / apt install git)"

if ! command -v bun >/dev/null 2>&1; then
  log "bun not found — installing..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "bun install failed — see https://bun.sh"
  ok "bun $(bun --version) installed"
fi

# Claude Code CLI is needed at runtime to spawn sessions.
if ! command -v claude >/dev/null 2>&1; then
  log "Claude Code CLI not found — installing @anthropic-ai/claude-code..."
  bun install -g @anthropic-ai/claude-code || die "failed to install Claude Code CLI"
  ok "claude $(claude --version 2>/dev/null | head -1) installed"
  log "NOTE: run \`claude\` once to log in before starting sessions."
fi

# --- clone / update ----------------------------------------------------------
CLONE_URL="https://github.com/$SLUG.git"
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/$SLUG.git"
fi

if [[ -d "$DEST/.git" ]]; then
  log "repo exists at $DEST — fetching..."
  git -C "$DEST" fetch --all --prune
else
  log "cloning $SLUG → $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone "$CLONE_URL" "$DEST"
fi
git -C "$DEST" checkout "$REF"
git -C "$DEST" pull --ff-only 2>/dev/null || true
ok "source @ $REF ($(git -C "$DEST" rev-parse --short HEAD))"

# --- build -------------------------------------------------------------------
log "installing deps + building..."
( cd "$DEST" && bun install && bun run build )
ok "built"

# --- manager script ----------------------------------------------------------
mkdir -p "$BIN_DIR"
cp "$DEST/scripts/claude-threads-install.sh" "$BIN_DIR/claude-threads-install.sh"
chmod +x "$BIN_DIR/claude-threads-install.sh"
# Pin the manager's default ref to whatever this install used.
sed -i.bak "s|^DEFAULT_REF=.*|DEFAULT_REF=\"\${CLAUDE_THREADS_DEFAULT_REF:-$REF}\"|" "$BIN_DIR/claude-threads-install.sh" && rm -f "$BIN_DIR/claude-threads-install.sh.bak"
ok "manager installed → $BIN_DIR/claude-threads-install.sh"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) log "NOTE: add $BIN_DIR to your PATH" ;; esac

# --- config ------------------------------------------------------------------
if [[ ! -f "$CONFIG" ]]; then
  log "no config found — launching setup wizard (bot tokens, channel, users)..."
  bash "$BIN_DIR/claude-threads-install.sh" setup || die "setup did not complete — rerun: claude-threads-install.sh setup"
else
  ok "existing config found at $CONFIG"
fi

# --- start -------------------------------------------------------------------
if [[ "${CLAUDE_THREADS_NO_START:-0}" == "1" ]]; then
  log "skipping daemon start (CLAUDE_THREADS_NO_START=1)"
elif [[ -f "$CONFIG" ]]; then
  bash "$BIN_DIR/claude-threads-install.sh" install "$REF"
  ok "bot is running"
  echo ""
  echo "  🖥  Agent dashboard:  http://127.0.0.1:7777"
  echo "  📦  Manage the bot:   claude-threads-install.sh status|install|rollback|setup"
  echo "  💬  In your channel:  @<botname> hello"
else
  log "no config — run \`claude-threads-install.sh setup\` then \`claude-threads-install.sh install\`"
fi

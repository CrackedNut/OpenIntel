#!/usr/bin/env bash
# OpenIntel one-liner installer — get a chat-driven Claude Code agent
# running on a fresh machine:
#
#   export GITHUB_TOKEN=github_pat_xxx   # repo is private — token needs Contents:read
#   curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" \
#     https://raw.githubusercontent.com/CrackedNut/OpenIntel/main/install.sh | bash
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
#   CLAUDE_THREADS_REPO_SLUG  github slug          (default: CrackedNut/OpenIntel)
#   CLAUDE_THREADS_REF        branch/tag to run    (default: main)
#   CLAUDE_THREADS_REPO       checkout path        (default: ~/code/claude-threads-agent)
#   GITHUB_TOKEN              REQUIRED (private repo): used for clone + raw fetch
#   CLAUDE_THREADS_NO_START   set 1 to skip starting the daemon

set -euo pipefail

SLUG="${CLAUDE_THREADS_REPO_SLUG:-CrackedNut/OpenIntel}"
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
elif [[ ! -d "$DEST/.git" ]]; then
  die "OpenIntel is a private repo — set GITHUB_TOKEN (fine-grained PAT with Contents:read) and re-run"
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
# Installed as `claude-threads` (the command) + `claude-threads-install.sh`
# (back-compat name). Same script either way.
mkdir -p "$BIN_DIR"
cp "$DEST/scripts/claude-threads-install.sh" "$BIN_DIR/claude-threads"
chmod +x "$BIN_DIR/claude-threads"
# Pin the manager's default ref to whatever this install used.
sed -i.bak "s|^DEFAULT_REF=.*|DEFAULT_REF=\"\${CLAUDE_THREADS_DEFAULT_REF:-$REF}\"|" "$BIN_DIR/claude-threads" && rm -f "$BIN_DIR/claude-threads.bak"
cp "$BIN_DIR/claude-threads" "$BIN_DIR/claude-threads-install.sh"
cp "$BIN_DIR/claude-threads" "$BIN_DIR/openintel"
ok "command installed → $BIN_DIR/claude-threads (alias: openintel)"

# Make sure $BIN_DIR is on PATH — PREPENDED, so our `claude-threads` wins over
# any npm/bun global shim of the upstream package.
PATH_LINE="export PATH=\"\$HOME/bin:\$PATH\""
add_path_line() {
  local profile="$1"
  [[ -f "$profile" ]] || touch "$profile"
  if ! grep -qF 'PATH="$HOME/bin:$PATH"' "$profile"; then
    printf '\n# claude-threads command\n%s\n' "$PATH_LINE" >> "$profile"
    ok "added ~/bin to PATH in $profile (open a new terminal to pick it up)"
  fi
}
case "${SHELL:-}" in
  */zsh)  add_path_line "$HOME/.zshrc" ;;
  */bash) add_path_line "$HOME/.bashrc" ;;
  *)      add_path_line "$HOME/.profile" ;;
esac

# Warn if a different claude-threads still shadows ours in the CURRENT shell.
existing="$(command -v claude-threads 2>/dev/null || true)"
if [[ -n "$existing" && "$existing" != "$BIN_DIR/claude-threads" ]]; then
  log "NOTE: '$existing' currently shadows this install — open a new terminal, or remove the npm/bun global package (bun remove -g claude-threads)"
fi

# --- agent content home --------------------------------------------------------
# Fresh machines won't have Hermes/agent-memory — seed a self-owned content
# dir that the dashboard's Persona/Projects/Skills tabs (and the bot's
# system-prompt builders) fall back to. Existing legacy locations always win.
AGENT_HOME="$HOME/.config/claude-threads/agent"
if [[ ! -d "$AGENT_HOME" ]]; then
  mkdir -p "$AGENT_HOME/projects" "$AGENT_HOME/skills"
  cat > "$AGENT_HOME/SOUL.md" <<'SOUL'
# Soul

Who this agent is: name, voice, and how it talks to your team.
Edit me in the dashboard (Persona tab) — new sessions pick changes up automatically.
SOUL
  cat > "$AGENT_HOME/DIRECTIVES.md" <<'DIRECTIVES'
# Directives

Hard behavioral rules the agent must always follow, e.g.:
- Never push to main — feature branches only.
- Ask before destructive actions.
DIRECTIVES
  ok "seeded agent content → $AGENT_HOME (edit via the dashboard)"
fi

# --- config ------------------------------------------------------------------
write_setup_mode_config() {
  # Minimal "setup mode" config: the bot starts with zero platforms and the
  # user connects Mattermost/Slack from the dashboard's Platforms tab.
  mkdir -p "$(dirname "$CONFIG")"
  cat > "$CONFIG" <<EOF
version: 1
workingDir: $HOME
chrome: false
worktreeMode: off
autoUpdate:
  enabled: false
platforms: []
EOF
  chmod 600 "$CONFIG"
  ok "setup-mode config written — connect a platform in the dashboard (Platforms tab)"
}

if [[ ! -f "$CONFIG" ]]; then
  if [[ -t 0 || -e /dev/tty ]]; then
    log "no config found — launching setup wizard (or press Ctrl+C and use the web dashboard instead)..."
    if ! bash "$BIN_DIR/claude-threads" setup; then
      log "wizard skipped — falling back to dashboard-based setup"
      write_setup_mode_config
    fi
  else
    log "no TTY available — using dashboard-based setup"
    write_setup_mode_config
  fi
else
  ok "existing config found at $CONFIG"
fi

# --- start -------------------------------------------------------------------
if [[ "${CLAUDE_THREADS_NO_START:-0}" == "1" ]]; then
  log "skipping daemon start (CLAUDE_THREADS_NO_START=1)"
elif [[ -f "$CONFIG" ]]; then
  bash "$BIN_DIR/claude-threads" install "$REF"
  ok "bot is running"
  echo ""
  echo "  🖥  Agent dashboard:  http://127.0.0.1:7777"
  echo "  📦  Manage the bot:   claude-threads status|install|setup|restart|panel|rollback"
  echo "  💬  In your channel:  @<botname> hello"
else
  log "no config — run \`claude-threads setup\` then \`claude-threads install\`"
fi

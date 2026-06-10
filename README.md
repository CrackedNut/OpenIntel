# OpenIntel

```
 ✴ ▄█▀ ███ ✴   OpenIntel
✴  █▀   █   ✴  autonomous Claude Code agents in your chat,
 ✴ ▀█▄  █  ✴   with a dashboard to run the whole operation
```

**OpenIntel turns Claude Code into a team of chat-native agents.** Run the bot on any machine, point it at a Mattermost or Slack channel, and the whole team can talk to an autonomous coding agent — watch it work in real time, approve its actions with emoji, spin up parallel sessions in threads, and manage everything (persona, skills, projects, config, logs) from a local web dashboard.

Built on a fork of [anneschuth/claude-threads](https://github.com/anneschuth/claude-threads) (Apache-2.0), extended into a self-contained agent platform.

## Install (one-liner)

```bash
curl -fsSL https://raw.githubusercontent.com/CrackedNut/OpenIntel/main/install.sh | bash
```

On a fresh machine this installs bun + the Claude Code CLI if missing, clones and builds OpenIntel, runs an interactive wizard for your bot token/channel, seeds an editable agent persona, starts the daemon, and prints the dashboard URL. Each device gets its own agent for its own project.

Already installed? Manage everything with the `claude-threads` command:

```bash
claude-threads status      # daemon, branch/commit, version
claude-threads panel       # open the dashboard
claude-threads logs        # tail the bot log
claude-threads setup       # reconfigure (tokens, channels, users)
claude-threads install     # pull latest, rebuild, restart
claude-threads rollback    # restore the previous build
claude-threads start|stop|restart
```

## The Dashboard

A local web panel at **http://127.0.0.1:7777** (binds localhost only), served by the bot itself:

- **Overview** — live sessions with model / context / cost, working-vs-idle state, per-session **Interrupt / Stop** controls, platform connection status
- **Persona** — edit the agent's `SOUL.md` (identity/tone) and `DIRECTIVES.md` (hard guardrails); new sessions pick changes up automatically
- **Projects** — manage the projects index injected into the agent's system prompt
- **Skills** — manage the agent's skill library (`SKILL.md` playbooks, flat or `category/skill` layouts)
- **Config** — edit the raw `config.yaml` with validation
- **Paths** — point persona/projects/skills at any directory per machine
- **Logs** — live tail of the daemon log with filtering
- **Update & restart** — one click pulls the latest main, rebuilds (with automatic snapshot for rollback), and restarts; sessions persist and resume

## In Chat

Mention the bot at the channel root and it becomes a **shared channel agent** — everyone allowed can talk to it, no thread required:

```
@yourbot what's the state of the deploy?
```

Spin up **parallel thread sessions** (each with its own Claude instance) without leaving the channel:

```
!thread fix the auth bug              # fresh thread session on a topic
!thread fix the auth bug -history    # seeded with recent channel conversation
```

The bot 👀-reacts when it accepts your message and flips it to ✅ when the turn completes, shows typing indicators, and streams output live.

### Features inherited & extended from claude-threads

- **Real-time streaming** of Claude's responses, tool use, diffs, and task lists into chat
- **Multi-platform** — multiple Mattermost and Slack workspaces simultaneously
- **Concurrent sessions** — channel-mode + any number of thread sessions, persisted across restarts
- **Permission modes** — `default` (every action prompts 👍/✅/👎), `auto` (classifier auto-approves low-risk), `bypass`; switch in-session with `!permissions <mode>`
- **Collaboration** — `!invite @user` / `!kick @user`; collaborators land as `Co-Authored-By:` trailers on commits
- **Git worktrees** — `!worktree feature/foo` isolates the agent's changes (also `list`, `switch`, `remove`, `cleanup`, `off`)
- **Files both ways** — drop any file into chat (100 MB cap) for Claude to read; Claude posts screenshots/PDFs/plots back via `send_file`
- **Permalink reading** — paste a Mattermost/Slack permalink and Claude resolves it via `read_post`
- **Multi-account Claude (opt-in)** — round-robin sessions across subscriptions/API keys with rate-limit cooldown

## Session Commands

Type `!help` in any session:

| Command                                     | Description                                                                              |
| :------------------------------------------ | :--------------------------------------------------------------------------------------- |
| `!thread <topic> [-history]`                | Spawn a new thread session from channel mode (own Claude instance)                       |
| `!help`                                     | Show available commands                                                                  |
| `!context` / `!cost` / `!compact`           | Context usage / token cost / compress context                                            |
| `!cd <path>`                                | Change working directory (restarts Claude)                                               |
| `!permissions <mode>`                       | Set permission mode: `default` / `auto` / `bypass`                                       |
| `!worktree <branch>`                        | Git worktree management (also: `list`, `switch`, `remove`, `cleanup`, `off`)             |
| `!plugin <list\|install\|uninstall> [name]` | Manage Claude Code plugins (restarts Claude)                                             |
| `!invite @user` / `!kick @user`             | Session collaboration                                                                    |
| `!github-email <email>`                     | Register your GitHub noreply email for commit attribution                                |
| `!queue <msg>` / `!steer <msg>`             | Buffer a message for when Claude is free / interrupt and redirect                        |
| `!search <query>`                           | Search the bot's session archives                                                        |
| `!bug <desc>`                               | Report a bug with context                                                                |
| `!approve`                                  | Approve pending plan (alternative to 👍)                                                 |
| `!escape`                                   | Interrupt current task (session stays active)                                            |
| `!stop`                                     | Stop this session                                                                        |
| `!kill`                                     | Emergency shutdown (ALL sessions + bot)                                                  |

## Interactive Controls

- **Permission approval**: 👍 allow once · ✅ allow all · 👎 deny
- **Plan approval**: 👍 approve · 👎 request changes
- **Questions**: 1️⃣ 2️⃣ 3️⃣ 4️⃣ for multiple choice
- **Session control**: ⏸️ interrupt · ❌/🛑 stop · 🔄 resume a timed-out session

## Agent Identity (Persona / Skills / Projects)

Every session's system prompt is assembled from editable content, resolved per machine:

| Content | What it is | Default location |
| :------ | :--------- | :--------------- |
| `SOUL.md` | Who the agent is — name, voice, tone | `~/.config/claude-threads/agent/SOUL.md` |
| `DIRECTIVES.md` | Hard behavioral rules | `~/.config/claude-threads/agent/DIRECTIVES.md` |
| Projects index | One `description.md` per ongoing project | `~/.config/claude-threads/agent/projects/` |
| Skills | `SKILL.md` playbooks the agent can invoke | `~/.config/claude-threads/agent/skills/` |

Legacy locations (`~/.hermes/*`, `~/agent-memory/projects`, `~/.claude/skills`) are auto-detected if present. Override any path in the dashboard's **Paths** tab.

## Prerequisites

- **Bun 1.2.21+** (the installer handles this) — or Node 20+
- **Claude Code CLI** logged in — test with `claude --version` (the installer installs it; run `claude` once to authenticate)

## Architecture (short version)

One daemon process per machine. Each chat session spawns its own `claude` CLI process with a per-session MCP server that routes permission prompts, file uploads, and permalink reads back through the platform. Sessions are keyed `platform:thread` (or `platform:channel` for the shared channel agent) and persist across restarts. The dashboard runs inside the bot process. See [CLAUDE.md](CLAUDE.md) for the full architecture and development guide, and [SETUP_GUIDE.md](SETUP_GUIDE.md) for platform bot creation.

## Development

```bash
bun install
bun run build     # bundle to dist/
bun test          # ~2,600 unit tests
bun run lint
```

Deployment on a managed machine is via `claude-threads install [ref]` — it snapshots the current build first, so `claude-threads rollback` always works.

## Credits & License

OpenIntel is a hard fork of [claude-threads](https://github.com/anneschuth/claude-threads) by Anne Schuth — the streaming engine, platform layer, session lifecycle, and permission system started there. Licensed Apache-2.0, same as upstream.

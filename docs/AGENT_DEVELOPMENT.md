# Agent Development Notes

A field guide for an AI agent (or human) making changes to OpenIntel. CLAUDE.md
covers the architecture and config surface; this doc is the **hard-won,
load-bearing stuff** — the workflow, the conventions, and the specific traps
that have actually bitten. Read this before touching the platform, session, or
command layers.

---

## 0. TL;DR for your first change

1. `bun install` once.
2. Make the change. Match the surrounding style.
3. **Write a red-green test**: confirm it FAILS without your fix, passes with it
   (`git stash` the source, run the test, `stash pop`). The repo's CLAUDE.md is
   emphatic about this and so am I — a test that passes without the fix is noise.
4. Gate: `bunx tsc --noEmit && bun test && bun run lint && bun run build` — all
   must be clean.
5. Ship (see §2): bump `package.json` version, add a CHANGELOG entry, commit,
   tag `vX.Y.Z`, push `main`, then `openintel install` to deploy.

There is no PR flow here — work lands on `main` directly. Keep `main` green.

---

## 1. Dev workflow & the pre-commit hook

- **Tests:** `bun test` (~2,900 unit tests, run from `src/`). Integration tests
  need Docker / a mock server and are separate (`bun run test:integration*`).
- **Typecheck:** `bunx tsc --noEmit`. Bun runs tests without typechecking, so
  TS errors only surface here — run it.
- **Lint:** `bun run lint` (eslint). Unused args must be prefixed `_`.
- **Build:** `bun run build` bundles `src/index.ts`, `src/mcp/mcp-server.ts`,
  and the statusline writer to `dist/` (bun, `--target node`).
- **Pre-commit (husky + lint-staged):** on `git commit` it runs `eslint --fix`,
  `bun test --bail`, and `tsc --noEmit` on staged files. It **reverts your
  working tree on failure**, so a failing commit leaves nothing committed —
  fix and retry. Two traps it has caught:
  - **`bun test --bail` runs only the STAGED test files.** `mock.module()` in
    bun is **process-global**, so a partial mock in one staged test leaks into
    another. Concretely: a `mock.module('../../claude/cli.js', …)` whose
    `MockClaudeCli` lacked `sendMessage` broke `lifecycle.test.ts` under
    `--bail` even though the full `bun test` passed (different file order).
    **Keep module mocks complete** (mirror `restart-rebind.test.ts`).
  - **knip** flags OS binaries used in tests as "unlisted". Don't shell out to
    `awk`/`ipconfig` in a test — use Node APIs (`os.networkInterfaces()` etc.).
    If you must, add to `knip.json` `ignoreBinaries`.

---

## 2. Release & deploy (read this before shipping)

**The version source of truth is `package.json#version`.** `src/version.ts`
reads it. The lockfiles (`bun.lock`, `package-lock.json`) carry stale root
metadata (`claude-threads` / old versions) — **do not** chase those.

**Versioning is an odometer, not semver** (user's rule): every push that ships
a change bumps the **patch** digit; at `.9` it rolls the **minor** and resets
patch (`2.1.9 → 2.2.0`). Mechanical — just tick it.

Release steps:
1. `package.json` version bump.
2. Add a `## [X.Y.Z] - DATE` section to `CHANGELOG.md` (keep `## [Unreleased]`
   above it). **Gotcha:** the channel sticky's "✨ What's new" blurb is parsed
   from the CURRENT version's CHANGELOG entry, and a sticky test asserts the
   active-sessions block doesn't contain a bot command — if your changelog
   mentions e.g. `` `!cd` ``, scope that test to `result.split('✨')[0]`.
3. `git commit`, `git tag vX.Y.Z`.
4. `git push origin main && git push origin vX.Y.Z`.
   - **Pushing to `main` may be denied by the permission gate** unless the user
     explicitly asked this turn. If denied, push the branch and stop — don't
     work around it. Same for deleting remote branches.
   - If a `git tag` lands on the wrong commit (e.g. a failed pre-commit aborted
     the version commit but the tag was already made), delete & recreate:
     `git tag -d vX.Y.Z; git push origin :refs/tags/vX.Y.Z`, fix, re-tag.
5. **Deploy:** `openintel install` (alias `claude-threads install`) — snapshots
   `dist/`, fetches origin, checks out `main`, rebuilds, restarts the daemon.
   Sessions persist and auto-resume across the restart. `openintel rollback`
   restores the previous snapshot. The manager's `DEFAULT_REF` is `main`, so a
   bare `install` deploys main — pass a ref to deploy a branch.
6. Update `package.json#description` and `README` when platform support or
   headline features change. Update the memory note if you keep one.

Docs-only changes don't need a deploy (the running bot is unaffected) — but if
you bump the version, deploy so `openintel status` matches `main`.

---

## 3. Architecture you must hold in your head

- **One daemon per machine.** Each chat session spawns its own `claude` CLI
  process plus a **per-session MCP child** (`src/mcp/mcp-server.ts`) that posts
  permission prompts, uploads files, and resolves permalinks back through the
  platform. The MCP child opens its OWN connection, independent of the main bot.
- **Platform abstraction:** `src/platform/client.ts` (`PlatformClient`
  interface) + `src/platform/base-client.ts` (`BasePlatformClient`, shared
  reconnect/heartbeat/allowlist). Implementations: `mattermost/`, `slack/`,
  `discord/`. Slack is the most faithful full template.
- **Normalized types** (`src/platform/types.ts`): `PlatformPost`,
  `PlatformUser`, `PlatformReaction`, `PlatformFile`, `ThreadMessage`. Every
  platform maps its native objects into these.
- **Session model** (`src/session/`): `manager.ts` orchestrates;
  `lifecycle.ts` is start/resume/exit; `reaction-router.ts` dispatches
  reactions; the real per-operation logic lives in `src/operations/` (the
  "brain": `message-manager.ts` + executors).
- **Lifecycle FSM** (`src/session/lifecycle-fsm.ts`): `starting → active →
  {paused, interrupted, restarting, cancelling, …}`. Illegal transitions warn
  (or throw under `CLAUDE_THREADS_FSM_STRICT=1`).

### Thread mode vs channel mode vs `allChannels`

This is the single most important model to understand — most session bugs live
here.

- Mode is decided **per message** from where it lands (`message-handler.ts`),
  NOT a config flag.
  - Reply inside a thread (`post.rootId` set) → **thread-mode** session keyed
    `platformId:threadRootPostId`; bot replies in the thread.
  - Post at channel root (no `rootId`) → **channel-mode** session keyed
    `platformId:channelId`; the session is SHARED across everyone in the
    channel; bot replies at channel root.
- **`allChannels: true`** (Mattermost/Discord): every channel the bot can see
  behaves like the home channel — a root mention starts that channel's
  channel-mode session. `!thread` opts a conversation into its own thread.
- **Reply-target convention (changed in the allChannels work):** channel-mode
  call sites pass `session.threadId` (which IS the channelId) as the reply
  target — **never `undefined`**. The platform clients recognize a "channel
  target" and post root-less in that channel. This is what makes replies route
  to the right channel under `allChannels`, and it removed the old
  "Invalid RootId" 400 class. (The old rule "never pass channelId to
  createPost" is obsolete.)
- **Discord is channel-mode everywhere:** a Discord thread is its own
  *channel*, so the normalizer always leaves `rootId` undefined and every
  channel/thread/DM is a channel-mode session. `!thread` on Discord creates a
  NATIVE thread (`createThread` → `message.startThread`) and runs a
  channel-mode session inside it. Mattermost/Slack keep reply-threading.

---

## 4. Traps that have actually bitten (don't re-learn these)

### 4a. Reactions need the post registered in the post→session index
The reaction router resolves which session a reaction belongs to via
`registry.findByPost(postId)`. **If you post an interactive message and expect
reactions on it, you MUST `ctx.ops.registerPost(post.id, session.threadId)`** —
otherwise the reaction maps to no session and is silently dropped. This bit the
`!model` picker (worktree prompt works precisely because it registers). Symptom:
"I react and nothing happens."

### 4b. The stale-exit / state-transition race on respawn & interrupt
When you kill/respawn the Claude CLI, its `exit` event fires **asynchronously
after** `kill()`. If anything moves the session out of its guard state
(`restarting` / `interrupted`) before that exit lands, `handleExit` takes the
wrong branch and **tears down the session you just rebuilt**. Two real bugs:
- `!cd`: a post-helper's defensive `transitionTo('active')` dropped the
  `restarting` guard. **Fix:** `restartClaudeSession` detaches the old CLI's
  event/exit/rate-limit listeners *before* `kill()`, and sets `active`
  explicitly on success.
- `!steer`: SIGINT makes Claude emit a final `result` then exit; the result
  handler was flushing the queued steer (flipping state to `active`) into the
  dying process. **Fix:** skip the queue flush while
  `isSessionInterrupted(session)` — let resume drain it.
General rule: **anything that respawns or interrupts must be robust to the old
process's late exit.**

### 4c. Soft-deleted sessions can black-hole a channel
`sessions.json` keeps soft-deleted sessions (`cleanedAt`) for 3 days. The
message-handler's "is there a paused session?" check includes soft-deleted
records, but resume must use the SAME any-state lookup
(`findByThreadIdAnyState`) — if the two disagree, every message routes to
"paused", resumes into nothing, and never starts a fresh session. Keep the
routing check and the resume lookup using the same filter.

### 4d. Channel-mode sessions and the post-exists check
`resumeSession` validated `threadId` as a post via `getPost`. Channel-mode
sessions carry the channelId in `threadId`, so that's always a 404 → every
channel session dropped on restart. Skip the post-exists check when
`state.mode === 'channel'`.

### 4e. `config.workingDir` was ignored
Sessions seeded cwd from `process.cwd()` (the daemon's launch dir) and ignored
`config.workingDir`. If you add a config field that should drive sessions,
thread it through `SessionConfig` (session-context) and the start/resume/restart
cliOptions — three places.

### 4f. Adding a `SessionOperations` op breaks every mock
`SessionContext.ops` (`session-context/types.ts`) is implemented by several test
mocks. Add a required op and `tsc` fails in `handler.test.ts`,
`events/handler.test.ts`, `lifecycle.test.ts` — add the stub to each (or make
the op optional and guard with `?.`).

---

## 5. Adding a feature: the usual touch-points

**A session-attribute command that respawns Claude** (model `!model` /
`!permissions` on these):
1. `ClaudeCliOptions` field + emit the flag in `cli.ts` `buildArgs`.
2. `Session` field (persist it: add to `PersistedSession`, the manager's
   persist serialization, and the lifecycle restore — and the
   `manager.test.ts` snapshot key list).
3. Apply it in `lifecycle.ts` start + resume cliOptions, and
   `restart-options.ts` `buildRestartCliOptions` (so `!cd` etc. carry it).
4. Command: `commands/parser.ts` pattern, `commands/registry.ts` entry,
   `commands/executor.ts` handler → `sessionManager.<method>`.
5. Respawn helper in `operations/commands/handler.ts` (mirror
   `setSessionPermissionMode`: keep current permission mode via
   `effectivePermissionMode`, resume if `hasClaudeResponded`,
   `restartClaudeSession`).
6. Interactive picker → `createInteractivePost` + **`registerPost`** (§4a) +
   reaction routing in `reaction-router.ts`.

**A new platform** (e.g. the Discord add):
- `platform/<name>/{client,formatter,types,upload,mcp-platform-api,permalink}.ts`
  + tests, mirroring `slack/`.
- Wire: `index.ts` `createPlatformClient` factory; `platform/index.ts` exports;
  `mcp-platform-api-factory.ts` case; `mcp-server.ts` (apiConfig branch,
  channel-id regex, read_post dispatch); `config/types.ts` config interface +
  the `'mattermost'|'slack'|…` union; `onboarding.ts`; dashboard
  `panel/server.ts` + `panel/ui.ts`; scattered union literals (`ui/types.ts`,
  `index.ts` status block).
- The `PlatformClient` interface has **optional** methods (`createThread`,
  `uploadFile`, `downloadFile`) — implement only what the platform supports;
  callers guard with `if (client.method)`.

---

## 6. Discord specifics (most recently added platform)

- Built on **discord.js** (the only platform with a heavy SDK dep). discord.js
  owns the Gateway (heartbeat/RESUME/reconnect) — the client does NOT use the
  base silence-heartbeat.
- **Requires the MESSAGE CONTENT privileged intent** (Developer Portal → Bot).
  Without it: `Used disallowed intents` on connect. `explainLoginError` turns
  that into actionable guidance.
- **Permission prompts are REST-only** — the MCP child POLLS the reactions
  endpoint (`waitForReaction`), it does NOT open a second Gateway per session.
- **Emoji:** OpenIntel speaks shortcodes (`eyes`, `white_check_mark`, `one`…);
  Discord speaks unicode. `discord/emoji-map.ts` translates both ways. When you
  add a number/emoji to the shared set (`utils/emoji.ts`), add it here too.
- **Channels:** `resolveChannel` fetches any channel by id (threads included);
  a `messageId → channelId` index covers reaction/edit targets.

---

## 7. Where things live (quick index)

| Need to… | Look at |
| --- | --- |
| Route an inbound message | `src/message-handler.ts` |
| Change session start/resume/exit | `src/session/lifecycle.ts` |
| Dispatch a reaction | `src/session/reaction-router.ts` |
| Add/edit a `!command` | `src/commands/{parser,registry,executor}.ts` + `src/operations/commands/handler.ts` |
| Respawn Claude with new options | `restartClaudeSession` + `restart-options.ts` |
| Spawn the Claude CLI / add a `--flag` | `src/claude/cli.ts` |
| Stream/format output to chat | `src/operations/{streaming,events,executors}/` |
| MCP tools (permission, send_file, read_post, search) | `src/mcp/mcp-server.ts` + `platform/*/mcp-platform-api.ts` |
| Persist session state | `src/persistence/session-store.ts` (mind backward-compat — defensive defaults, never remove fields) |
| Dashboard | `src/panel/{server,ui}.ts` |
| Config schema | `src/config/types.ts` |

---

## 8. Etiquette

- Match comment density and idiom of the surrounding file. Comments state
  constraints the code can't show — not narration.
- Keep `main` green; keep the CHANGELOG honest.
- For destructive or outward-facing actions (deleting branches, force-push,
  anything that restarts the live bot), confirm intent first unless the user
  asked this turn.

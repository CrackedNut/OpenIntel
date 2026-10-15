/**
 * Stable agent name for a chat session, passed to `claude --name`.
 *
 * Claude Code names every session `<cwd basename>-<random hex>` (e.g. `code-2b`)
 * and other sessions address it by that name. Left alone, the name changes on
 * every bot restart, resume, `!cd` or worktree switch, so a peer that learned
 * "code-2b" loses track of the chat. We pick the name once, when the session
 * starts, persist it with the session, and pass it on every spawn.
 *
 * The name is the chat's CHANNEL name when the platform can tell us
 * (`PlatformClient.getChannelName`):
 *   - channel-mode session (one per channel) → `<channel>`         e.g. `nook-dev`
 *   - thread session inside a channel        → `<channel>-<hex>`   e.g. `nook-dev-2b7`
 * Otherwise (lookup unsupported/failed) it falls back to Claude's own shape,
 * `<working dir>-<hex>`. The hex comes from platform + thread, so it is stable.
 */
import { createHash } from 'crypto';
import { basename } from 'path';

const HEX_CHARS = 3;

export function slugifyAgentName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function threadHex(platformId: string, threadId: string): string {
  return createHash('sha256').update(`${platformId}:${threadId}`).digest('hex').slice(0, HEX_CHARS);
}

export interface AgentNameInput {
  workingDir: string;
  platformId: string;
  threadId: string;
  /** Channel name from the platform, if known. */
  channelName?: string | null;
  /** True for a channel-mode session (the whole channel is one session). */
  channelMode?: boolean;
}

export function makeAgentName(input: AgentNameInput): string {
  const hex = threadHex(input.platformId, input.threadId);
  const channel = input.channelName ? slugifyAgentName(input.channelName) : '';
  if (channel) return input.channelMode ? channel : `${channel}-${hex}`;
  const dir = slugifyAgentName(basename(input.workingDir)) || 'agent';
  return `${dir}-${hex}`;
}

/** Look the channel name up (when the platform supports it) and build the name. */
export async function resolveAgentName(
  platform: { getChannelName?(channelId: string): Promise<string | null> },
  input: Omit<AgentNameInput, 'channelName'> & { channelId?: string },
): Promise<string> {
  let channelName: string | null = null;
  if (input.channelId && platform.getChannelName) {
    try {
      channelName = await platform.getChannelName(input.channelId);
    } catch {
      channelName = null;
    }
  }
  return makeAgentName({ ...input, channelName });
}

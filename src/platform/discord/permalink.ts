/**
 * Discord permalink support for the MCP `read_post` tool.
 *
 * Discord message links look like:
 *   https://discord.com/channels/{guildId|@me}/{channelId}/{messageId}
 * (canary./ptb. subdomains and the legacy discordapp.com host are accepted.)
 *
 * Mirrors the Slack permalink module's shape so the MCP server consumes all
 * platforms uniformly.
 */
import type { McpPlatformApi, McpPost } from '../mcp-platform-api.js';
import { truncateBody, quoteBlock } from '../permalink-shared.js';

export interface ParsedDiscordPermalink {
  channelId: string;
  messageId: string;
}

export interface ResolvedDiscordPermalink {
  post: McpPost;
  thread: McpPost[];
}

export type ResolveError =
  | { kind: 'wrong-channel' }
  | { kind: 'not-found' }
  | { kind: 'unsupported' };

export type ResolveResult =
  | { ok: true; resolved: ResolvedDiscordPermalink }
  | { ok: false; error: ResolveError };

const DISCORD_LINK_RE =
  /^https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(?:@me|\d+)\/(\d+)\/(\d+)/i;

export function parseDiscordPermalink(url: string): ParsedDiscordPermalink | null {
  const m = url.match(DISCORD_LINK_RE);
  if (!m) return null;
  return { channelId: m[1], messageId: m[2] };
}

export async function resolveDiscordPermalink(
  api: McpPlatformApi,
  parsed: ParsedDiscordPermalink,
  botChannelId: string,
): Promise<ResolveResult> {
  // Scope to the bot's own channel — same guard as the Slack resolver.
  if (parsed.channelId !== botChannelId) {
    return { ok: false, error: { kind: 'wrong-channel' } };
  }
  if (!api.readPost) {
    return { ok: false, error: { kind: 'unsupported' } };
  }
  const post = await api.readPost(parsed.messageId);
  if (!post) {
    return { ok: false, error: { kind: 'not-found' } };
  }
  return { ok: true, resolved: { post, thread: [] } };
}

export function formatResolvedDiscord(resolved: ResolvedDiscordPermalink): string {
  const { post } = resolved;
  const lines: string[] = [];
  lines.push(`Discord message by @${post.username ?? 'unknown'}:`);
  lines.push('');
  lines.push(quoteBlock(truncateBody(post.message)));
  return lines.join('\n');
}

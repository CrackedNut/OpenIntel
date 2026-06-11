/**
 * Discord implementation of McpPlatformApi (the MCP child surface).
 *
 * Deliberately REST-only — no discord.js, no Gateway. The child posts the
 * permission prompt, adds the option reactions, and POLLS the reactions
 * endpoint until an allowed (non-bot) user reacts. Running a Gateway client
 * per session just to await one reaction would be wasteful; a 2s poll is
 * plenty for a human approval.
 */
import type {
  McpPlatformApi,
  DiscordMcpApiConfig,
  ReactionEvent,
  PostedMessage,
  McpPost,
} from '../mcp-platform-api.js';
import type { PlatformFormatter } from '../formatter.js';
import { DiscordFormatter } from './formatter.js';
import { toDiscordEmoji, fromDiscordEmoji } from './emoji-map.js';
import { createLogger } from '../../utils/logger.js';
import { readFileSync } from 'fs';
import { basename } from 'path';

const log = createLogger('discord-mcp');

interface DiscordMessage {
  id: string;
  channel_id: string;
  author?: { id: string; username?: string; bot?: boolean };
  content: string;
  timestamp?: string;
  reactions?: Array<{ emoji: { id: string | null; name: string | null } }>;
}

class DiscordMcpPlatformApi implements McpPlatformApi {
  private readonly formatter = new DiscordFormatter();
  private readonly base: string;
  private botUserId: string | null = null;

  constructor(private config: DiscordMcpApiConfig) {
    this.base = config.apiUrl || 'https://discord.com/api/v10';
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '1') * 1000;
      await new Promise((r) => setTimeout(r, retry));
      return this.api<T>(method, path, body);
    }
    if (!res.ok) {
      throw new Error(`Discord API ${method} ${path} → ${res.status}: ${await res.text()}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  getFormatter(): PlatformFormatter {
    return this.formatter;
  }

  async getBotUserId(): Promise<string> {
    if (this.botUserId) return this.botUserId;
    const me = await this.api<{ id: string }>('GET', '/users/@me');
    this.botUserId = me.id;
    return me.id;
  }

  async getUsername(userId: string): Promise<string | null> {
    try {
      const u = await this.api<{ username?: string }>('GET', `/users/${userId}`);
      return u.username ?? null;
    } catch {
      return null;
    }
  }

  isUserAllowed(username: string): boolean {
    if (this.config.allowedUsers.length === 0) return true;
    return this.config.allowedUsers.includes(username);
  }

  async createInteractivePost(
    message: string,
    reactions: string[],
    threadId?: string,
  ): Promise<PostedMessage> {
    const channelId = threadId || this.config.channelId;
    const msg = await this.api<DiscordMessage>('POST', `/channels/${channelId}/messages`, {
      content: message.slice(0, 2000),
      allowed_mentions: { parse: ['users'] },
    });
    for (const emoji of reactions) {
      const enc = encodeURIComponent(toDiscordEmoji(emoji));
      try {
        await this.api('PUT', `/channels/${channelId}/messages/${msg.id}/reactions/${enc}/@me`);
      } catch (err) {
        log.warn(`Failed to add option reaction ${emoji}: ${err}`);
      }
    }
    return { id: msg.id };
  }

  async updatePost(postId: string, message: string): Promise<void> {
    await this.api('PATCH', `/channels/${this.config.channelId}/messages/${postId}`, {
      content: message.slice(0, 2000),
      allowed_mentions: { parse: ['users'] },
    });
  }

  async waitForReaction(
    postId: string,
    botUserId: string,
    timeoutMs: number,
  ): Promise<ReactionEvent | null> {
    const channelId = this.config.channelId;
    const deadline = Date.now() + timeoutMs;
    const pollMs = 2000;

    while (Date.now() < deadline) {
      try {
        const msg = await this.api<DiscordMessage>(
          'GET',
          `/channels/${channelId}/messages/${postId}`,
        );
        for (const r of msg.reactions ?? []) {
          const name = r.emoji.name;
          if (!name) continue; // custom emoji — not part of our vocabulary
          const enc = encodeURIComponent(name);
          const users = await this.api<Array<{ id: string }>>(
            'GET',
            `/channels/${channelId}/messages/${postId}/reactions/${enc}?limit=25`,
          );
          const reactor = users.find((u) => u.id !== botUserId);
          if (reactor) {
            return { postId, userId: reactor.id, emojiName: fromDiscordEmoji(name) };
          }
        }
      } catch (err) {
        log.debug(`waitForReaction poll error: ${err}`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
  }

  async addReaction(postId: string, emojiName: string): Promise<void> {
    const enc = encodeURIComponent(toDiscordEmoji(emojiName));
    await this.api(
      'PUT',
      `/channels/${this.config.channelId}/messages/${postId}/reactions/${enc}/@me`,
    );
  }

  async uploadFile(
    filePath: string,
    threadId: string,
    options?: { caption?: string; filename?: string },
  ): Promise<{ postId: string }> {
    const channelId = threadId || this.config.channelId;
    const filename = options?.filename || basename(filePath);
    const form = new FormData();
    const bytes = readFileSync(filePath);
    form.append(
      'payload_json',
      JSON.stringify({
        content: options?.caption,
        allowed_mentions: { parse: [] },
        attachments: [{ id: 0, filename }],
      }),
    );
    form.append('files[0]', new Blob([bytes]), filename);
    const res = await fetch(`${this.base}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${this.config.token}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Discord upload failed: ${res.status} ${await res.text()}`);
    const msg = (await res.json()) as DiscordMessage;
    return { postId: msg.id };
  }

  private toMcpPost(m: DiscordMessage): McpPost {
    return {
      id: m.id,
      channelId: m.channel_id,
      userId: m.author?.id ?? '',
      username: m.author?.username ?? null,
      message: m.content,
      createAt: m.timestamp ? Date.parse(m.timestamp) : 0,
    };
  }

  async readPost(postId: string): Promise<McpPost | null> {
    try {
      const m = await this.api<DiscordMessage>(
        'GET',
        `/channels/${this.config.channelId}/messages/${postId}`,
      );
      return this.toMcpPost(m);
    } catch {
      return null;
    }
  }

  async readChannelHistory(
    channelId: string,
    options?: { limit?: number },
  ): Promise<McpPost[] | null> {
    try {
      const limit = Math.min(options?.limit ?? 30, 100);
      const msgs = await this.api<DiscordMessage[]>(
        'GET',
        `/channels/${channelId}/messages?limit=${limit}`,
      );
      return msgs.map((m) => this.toMcpPost(m)).sort((a, b) => a.createAt - b.createAt);
    } catch {
      return null;
    }
  }

  async getChannelInfo(
    channelId: string,
  ): Promise<{ id: string; channelType: 'public' | 'private'; name?: string } | null> {
    try {
      const c = await this.api<{ id: string; name?: string; type: number }>(
        'GET',
        `/channels/${channelId}`,
      );
      // Discord channel type 0 = public guild text; others (threads, DMs,
      // private) are treated as private for the read_post scope guard.
      return { id: c.id, channelType: c.type === 0 ? 'public' : 'private', name: c.name };
    } catch {
      return null;
    }
  }
}

export function createDiscordMcpPlatformApi(config: DiscordMcpApiConfig): McpPlatformApi {
  return new DiscordMcpPlatformApi(config);
}

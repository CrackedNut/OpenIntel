import { describe, it, expect } from 'bun:test';
import {
  parseDiscordPermalink,
  resolveDiscordPermalink,
  formatResolvedDiscord,
} from './permalink.js';
import type { McpPlatformApi, McpPost } from '../mcp-platform-api.js';

describe('parseDiscordPermalink', () => {
  it('parses a standard guild message link', () => {
    expect(parseDiscordPermalink('https://discord.com/channels/111/222/333')).toEqual({
      channelId: '222',
      messageId: '333',
    });
  });

  it('parses @me (DM) links and canary/ptb/discordapp hosts', () => {
    expect(parseDiscordPermalink('https://discord.com/channels/@me/444/555')?.channelId).toBe('444');
    expect(parseDiscordPermalink('https://canary.discord.com/channels/1/2/3')?.messageId).toBe('3');
    expect(parseDiscordPermalink('https://ptb.discord.com/channels/1/2/3')?.channelId).toBe('2');
    expect(parseDiscordPermalink('https://discordapp.com/channels/1/2/3')?.messageId).toBe('3');
  });

  it('rejects non-discord and malformed urls', () => {
    expect(parseDiscordPermalink('https://example.com/channels/1/2/3')).toBeNull();
    expect(parseDiscordPermalink('https://discord.com/channels/1/2')).toBeNull();
    expect(parseDiscordPermalink('not a url')).toBeNull();
  });
});

function apiWith(post: McpPost | null): McpPlatformApi {
  return {
    getFormatter: () => ({}) as never,
    getBotUserId: async () => 'bot',
    getUsername: async () => null,
    isUserAllowed: () => true,
    createInteractivePost: async () => ({ id: 'x' }),
    updatePost: async () => {},
    waitForReaction: async () => null,
    readPost: async () => post,
  };
}

describe('resolveDiscordPermalink', () => {
  const parsed = { channelId: 'chan-1', messageId: 'm-1' };

  it('rejects a permalink for another channel', async () => {
    const res = await resolveDiscordPermalink(apiWith(null), parsed, 'other-channel');
    expect(res).toEqual({ ok: false, error: { kind: 'wrong-channel' } });
  });

  it('returns not-found when the post is missing', async () => {
    const res = await resolveDiscordPermalink(apiWith(null), parsed, 'chan-1');
    expect(res).toEqual({ ok: false, error: { kind: 'not-found' } });
  });

  it('resolves an in-channel post', async () => {
    const post: McpPost = { id: 'm-1', channelId: 'chan-1', userId: 'u1', username: 'alice', message: 'hi', createAt: 0 };
    const res = await resolveDiscordPermalink(apiWith(post), parsed, 'chan-1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolved.post.message).toBe('hi');
      expect(formatResolvedDiscord(res.resolved)).toContain('@alice');
    }
  });

  it('reports unsupported when the api has no readPost', async () => {
    const api = { ...apiWith(null) };
    delete (api as { readPost?: unknown }).readPost;
    const res = await resolveDiscordPermalink(api, parsed, 'chan-1');
    expect(res).toEqual({ ok: false, error: { kind: 'unsupported' } });
  });
});

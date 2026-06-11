/**
 * Discord client unit tests — the pure mapping logic (mention matching, the
 * channel-mode normalization, DM mention-injection, config). The gateway
 * itself is discord.js's job and isn't exercised here.
 */
import { describe, it, expect } from 'bun:test';
import { ChannelType } from 'discord.js';
import { DiscordClient } from './client.js';
import type { DiscordPlatformConfig } from '../../config/index.js';

function makeClient(overrides: Partial<DiscordPlatformConfig> = {}): DiscordClient {
  const config: DiscordPlatformConfig = {
    id: 'discord-main',
    type: 'discord',
    displayName: 'Test',
    token: 'bot-token',
    channelId: 'home-channel-123',
    botName: 'claude',
    allowedUsers: ['alice'],
    ...overrides,
  };
  const c = new DiscordClient(config);
  // Pretend the gateway handshake set our identity.
  (c as unknown as { botUserId: string }).botUserId = 'bot-999';
  (c as unknown as { botUsername: string }).botUsername = 'claude';
  return c;
}

// Minimal Message-like fixture for the private normalizer.
function fakeMessage(opts: {
  id?: string;
  channelId: string;
  channelType?: ChannelType;
  authorId?: string;
  content: string;
  attachments?: Array<{ id: string; name: string; size: number; contentType?: string }>;
}) {
  const atts = new Map((opts.attachments ?? []).map((a) => [a.id, a]));
  return {
    id: opts.id ?? 'msg-1',
    channel: { id: opts.channelId, type: opts.channelType ?? ChannelType.GuildText },
    author: { id: opts.authorId ?? 'user-1', username: 'alice', bot: false },
    content: opts.content,
    createdTimestamp: 1000,
    system: false,
    attachments: { size: atts.size, values: () => atts.values() },
  };
}

describe('DiscordClient identity & config', () => {
  it('reports the home channel and discord mcp config', () => {
    const c = makeClient();
    expect(c.getHomeChannelId()).toBe('home-channel-123');
    expect(c.platformType).toBe('discord');
    const mcp = c.getMcpConfig();
    expect(mcp.type).toBe('discord');
    expect(mcp.token).toBe('bot-token');
    expect(mcp.channelId).toBe('home-channel-123');
    expect(mcp.allowedUsers).toEqual(['alice']);
  });

  it('uses Discord 2000-char message limits', () => {
    expect(makeClient().getMessageLimits()).toEqual({ maxLength: 2000, hardThreshold: 1900 });
  });

  it('builds a guild message permalink', () => {
    const c = makeClient();
    expect(c.getThreadLink('chan-1', 'msg-5')).toBe('https://discord.com/channels/@me/chan-1/msg-5');
  });
});

describe('DiscordClient mention matching', () => {
  it('matches <@id> and <@!id> for the bot', () => {
    const c = makeClient();
    expect(c.isBotMentioned('hey <@bot-999> do x')).toBe(true);
    expect(c.isBotMentioned('hey <@!bot-999> do x')).toBe(true);
    expect(c.isBotMentioned('hey <@someone-else> do x')).toBe(false);
    expect(c.isBotMentioned('no mention')).toBe(false);
  });

  it('strips the bot mention from the prompt', () => {
    const c = makeClient();
    expect(c.extractPrompt('<@bot-999> build it')).toBe('build it');
    expect(c.extractPrompt('build it <@!bot-999>')).toBe('build it');
  });
});

describe('DiscordClient normalization (channel-mode model)', () => {
  it('normalizes a guild message with rootId undefined (every channel is channel-mode)', () => {
    const c = makeClient();
    const post = (c as unknown as { normalizePost: (m: unknown, dm: boolean) => unknown }).normalizePost(
      fakeMessage({ channelId: 'chan-7', content: 'hello' }),
      false,
    ) as { channelId: string; rootId?: string; message: string; userId: string };
    expect(post.channelId).toBe('chan-7');
    expect(post.rootId).toBeUndefined();
    expect(post.message).toBe('hello');
  });

  it('injects the bot mention into DM content so DMs need no explicit @mention', () => {
    const c = makeClient();
    const post = (c as unknown as { normalizePost: (m: unknown, dm: boolean) => unknown }).normalizePost(
      fakeMessage({ channelId: 'dm-1', channelType: ChannelType.DM, content: 'hi there' }),
      true,
    ) as { message: string };
    expect(post.message).toBe('<@bot-999> hi there');
    expect(c.isBotMentioned(post.message)).toBe(true);
  });

  it('maps attachments into platform files', () => {
    const c = makeClient();
    const post = (c as unknown as { normalizePost: (m: unknown, dm: boolean) => unknown }).normalizePost(
      fakeMessage({
        channelId: 'chan-7',
        content: 'see file',
        attachments: [{ id: 'f1', name: 'log.txt', size: 12, contentType: 'text/plain' }],
      }),
      false,
    ) as { metadata?: { files?: Array<{ name: string; extension?: string }> } };
    expect(post.metadata?.files?.[0].name).toBe('log.txt');
    expect(post.metadata?.files?.[0].extension).toBe('txt');
  });
});

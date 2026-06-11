import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createDiscordMcpPlatformApi } from './mcp-platform-api.js';
import type { DiscordMcpApiConfig } from '../mcp-platform-api.js';

const config: DiscordMcpApiConfig = {
  platformType: 'discord',
  token: 'bot-token',
  channelId: 'chan-1',
  allowedUsers: ['alice'],
};

type Responder = (url: string, init?: RequestInit) => { status?: number; body?: unknown };
let responder: Responder;
let calls: Array<{ url: string; method: string; body?: unknown }>;
const realFetch = global.fetch;

beforeEach(() => {
  calls = [];
  global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = url.toString();
    calls.push({
      url: u,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const r = responder(u, init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof global.fetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

describe('DiscordMcpPlatformApi', () => {
  it('isUserAllowed honors the allowlist', () => {
    const api = createDiscordMcpPlatformApi(config);
    expect(api.isUserAllowed('alice')).toBe(true);
    expect(api.isUserAllowed('mallory')).toBe(false);
    expect(createDiscordMcpPlatformApi({ ...config, allowedUsers: [] }).isUserAllowed('anyone')).toBe(true);
  });

  it('createInteractivePost posts content and adds each option reaction (shortcode→unicode)', async () => {
    responder = (u) => {
      if (u.endsWith('/messages')) return { body: { id: 'm-1', channel_id: 'chan-1', content: 'x' } };
      return { status: 204 };
    };
    const api = createDiscordMcpPlatformApi(config);
    const post = await api.createInteractivePost('approve?', ['white_check_mark', 'x']);
    expect(post.id).toBe('m-1');
    const reactionPuts = calls.filter((c) => c.method === 'PUT' && c.url.includes('/reactions/'));
    expect(reactionPuts.length).toBe(2);
    // ✅ and ❌ must be url-encoded in the path
    expect(reactionPuts[0].url).toContain(encodeURIComponent('✅'));
    expect(reactionPuts[1].url).toContain(encodeURIComponent('❌'));
  });

  it('waitForReaction returns the first non-bot reactor with the shortcode', async () => {
    responder = (u) => {
      if (u.includes('/reactions/')) return { body: [{ id: 'bot-1' }, { id: 'alice' }] };
      if (u.match(/\/messages\/m-1$/)) return { body: { id: 'm-1', reactions: [{ emoji: { id: null, name: '✅' } }] } };
      return { body: {} };
    };
    const api = createDiscordMcpPlatformApi(config);
    const res = await api.waitForReaction('m-1', 'bot-1', 5000);
    expect(res).not.toBeNull();
    expect(res!.userId).toBe('alice');
    expect(res!.emojiName).toBe('white_check_mark'); // ✅ → shortcode
    expect(res!.postId).toBe('m-1');
  });

  it('waitForReaction returns null on timeout when only the bot has reacted', async () => {
    responder = (u) => {
      if (u.includes('/reactions/')) return { body: [{ id: 'bot-1' }] };
      if (u.match(/\/messages\/m-2$/)) return { body: { id: 'm-2', reactions: [{ emoji: { id: null, name: '✅' } }] } };
      return { body: {} };
    };
    const api = createDiscordMcpPlatformApi(config);
    const res = await api.waitForReaction('m-2', 'bot-1', 50); // sub-poll timeout
    expect(res).toBeNull();
  });

  it('readPost maps a discord message to an McpPost', async () => {
    responder = () => ({
      body: { id: 'm-3', channel_id: 'chan-1', author: { id: 'u1', username: 'alice' }, content: 'hi', timestamp: '2026-06-11T00:00:00.000Z' },
    });
    const api = createDiscordMcpPlatformApi(config);
    const post = await api.readPost!('m-3');
    expect(post).not.toBeNull();
    expect(post!.username).toBe('alice');
    expect(post!.message).toBe('hi');
    expect(post!.channelId).toBe('chan-1');
  });
});

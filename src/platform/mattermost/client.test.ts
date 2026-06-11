/**
 * Unit tests for MattermostClient. HTTP calls are isolated by stubbing
 * `global.fetch`; WebSocket paths are exercised via the pure helpers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MattermostClient } from './client.js';
import type { MattermostPlatformConfig } from '../../config/index.js';

// -----------------------------------------------------------------------------
// Fetch harness
// -----------------------------------------------------------------------------

type FetchResponder = (url: string, init?: RequestInit) => Promise<Response> | Response;

let fetchResponder: FetchResponder = () =>
  new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
let fetchCalls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];

const originalFetch = global.fetch;
beforeEach(() => {
  fetchCalls = [];
  global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k];
    }
    let body: unknown;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    fetchCalls.push({ url: urlStr, method, headers, body });
    return fetchResponder(urlStr, init);
  }) as typeof global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, text = 'oops'): Response {
  return new Response(text, { status });
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function makeConfig(overrides: Partial<MattermostPlatformConfig> = {}): MattermostPlatformConfig {
  return {
    id: 'mm-main',
    type: 'mattermost',
    displayName: 'Main',
    url: 'https://chat.example.test',
    token: 'secret-token',
    channelId: 'c-123',
    botName: 'claude',
    allowedUsers: ['alice', 'bob'],
    skipPermissions: false,
    ...overrides,
  };
}

function makeClient(overrides: Partial<MattermostPlatformConfig> = {}): MattermostClient {
  return new MattermostClient(makeConfig(overrides));
}

// -----------------------------------------------------------------------------
// Pure method tests
// -----------------------------------------------------------------------------

describe('MattermostClient pure helpers', () => {
  it('getMessageLimits returns Mattermost defaults', () => {
    expect(makeClient().getMessageLimits()).toEqual({ maxLength: 16000, hardThreshold: 14000 });
  });

  it('isBotMentioned matches @botname at start and mid-message', () => {
    const c = makeClient({ botName: 'claude' });
    expect(c.isBotMentioned('@claude do stuff')).toBe(true);
    expect(c.isBotMentioned('hey @claude please')).toBe(true);
    expect(c.isBotMentioned('no mention here')).toBe(false);
    expect(c.isBotMentioned('email me at claude@example.com')).toBe(false);
  });

  it('isBotMentioned is case-insensitive', () => {
    const c = makeClient({ botName: 'Claude' });
    expect(c.isBotMentioned('@claude hi')).toBe(true);
    expect(c.isBotMentioned('@CLAUDE hi')).toBe(true);
  });

  it('isBotMentioned handles bot names with special regex chars', () => {
    const c = makeClient({ botName: 'bot.v2' });
    expect(c.isBotMentioned('@bot.v2 hello')).toBe(true);
    // Literal dot should NOT match arbitrary chars
    expect(c.isBotMentioned('@botXv2 hello')).toBe(false);
  });

  it('isBotMentioned also matches the real account username when config botName drifts', () => {
    // Regression: config said botName "thropic" while the account was
    // "natethropic" — @natethropic never matched @thropic\b, so the bot
    // silently ignored every mention. The real username (captured at
    // getBotUser) must match too.
    const c = makeClient({ botName: 'thropic' });
    expect(c.isBotMentioned('@natethropic hey')).toBe(false); // not fetched yet
    (c as unknown as { botUsername: string }).botUsername = 'natethropic';
    expect(c.isBotMentioned('@natethropic hey')).toBe(true);
    expect(c.isBotMentioned('@thropic hey')).toBe(true); // configured name still works
    expect(c.isBotMentioned('no mention')).toBe(false);
    expect(c.extractPrompt('@natethropic do the thing')).toBe('do the thing');
  });

  it('extractPrompt strips bot mention and trims', () => {
    const c = makeClient({ botName: 'claude' });
    expect(c.extractPrompt('@claude write a test')).toBe('write a test');
    expect(c.extractPrompt('hey @claude fix this')).toBe('hey  fix this'.trim());
  });

  it('getMcpConfig exposes the platform credentials', () => {
    const c = makeClient({ url: 'https://x', token: 't', channelId: 'cc', allowedUsers: ['u'] });
    expect(c.getMcpConfig()).toEqual({
      type: 'mattermost',
      id: 'mm-main',
      url: 'https://x',
      token: 't',
      channelId: 'cc',
      allowedUsers: ['u'],
      outboundFiles: undefined,
    });
  });

  it('getMcpConfig surfaces outboundFiles when configured', () => {
    const c = makeClient({
      url: 'https://x',
      token: 't',
      channelId: 'cc',
      allowedUsers: ['u'],
      outboundFiles: { enabled: false, maxBytes: 5_000_000 },
    });
    expect(c.getMcpConfig().outboundFiles).toEqual({ enabled: false, maxBytes: 5_000_000 });
  });

  it('getFormatter returns a stable formatter instance', () => {
    const c = makeClient();
    expect(c.getFormatter()).toBe(c.getFormatter());
  });

  it('getThreadLink uses lastMessageId when provided', () => {
    const c = makeClient({ url: 'https://x.test' });
    expect(c.getThreadLink('thread-1')).toBe('https://x.test/_redirect/pl/thread-1');
    expect(c.getThreadLink('thread-1', 'msg-9')).toBe('https://x.test/_redirect/pl/msg-9');
  });

  it('platform identity fields reflect config', () => {
    const c = makeClient({ id: 'mm-x', displayName: 'X' });
    expect(c.platformId).toBe('mm-x');
    expect(c.displayName).toBe('X');
    expect(c.platformType).toBe('mattermost');
  });
});

// -----------------------------------------------------------------------------
// HTTP method tests
// -----------------------------------------------------------------------------

describe('MattermostClient HTTP methods', () => {
  it('createPost posts to /posts with channel and body, returns normalized post', async () => {
    fetchResponder = () =>
      jsonResponse({
        id: 'p-1',
        channel_id: 'c-123',
        user_id: 'bot',
        message: 'hi',
        root_id: '',
        create_at: 1000,
      });
    const c = makeClient();
    const post = await c.createPost('hi');
    expect(post.id).toBe('p-1');
    expect(post.channelId).toBe('c-123');
    expect(post.userId).toBe('bot');
    expect(post.platformId).toBe('mm-main');

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call.url).toBe('https://chat.example.test/api/v4/posts');
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer secret-token');
    expect(call.body).toEqual({ channel_id: 'c-123', message: 'hi', root_id: undefined });
  });

  it('createPost includes root_id when threadId is given', async () => {
    fetchResponder = () =>
      jsonResponse({ id: 'p', channel_id: 'c', user_id: 'u', message: '', root_id: 't', create_at: 1 });
    await makeClient().createPost('reply', 'thread-abc');
    expect((fetchCalls[0].body as Record<string, unknown>).root_id).toBe('thread-abc');
  });

  it('updatePost PUTs to /posts/:id', async () => {
    fetchResponder = () =>
      jsonResponse({ id: 'p-1', channel_id: 'c', user_id: 'u', message: 'updated', root_id: '', create_at: 1 });
    const result = await makeClient().updatePost('p-1', 'updated');
    expect(result.message).toBe('updated');
    expect(fetchCalls[0].method).toBe('PUT');
    expect(fetchCalls[0].url).toContain('/posts/p-1');
  });

  it('addReaction POSTs to /reactions', async () => {
    fetchResponder = () => jsonResponse({});
    await makeClient().addReaction('p-1', '+1');
    const call = fetchCalls[0];
    expect(call.method).toBe('POST');
    expect(call.url).toContain('/reactions');
    expect((call.body as Record<string, unknown>).emoji_name).toBe('+1');
    expect((call.body as Record<string, unknown>).post_id).toBe('p-1');
  });

  it('removeReaction DELETEs to scoped endpoint', async () => {
    fetchResponder = () => jsonResponse({});
    await makeClient().removeReaction('p-1', '+1');
    expect(fetchCalls[0].method).toBe('DELETE');
    expect(fetchCalls[0].url).toContain('/posts/p-1/reactions/+1');
  });

  it('getPost returns null on error instead of throwing', async () => {
    fetchResponder = () => errorResponse(404, 'not found');
    const post = await makeClient().getPost('missing');
    expect(post).toBeNull();
  });

  it('unpinPost swallows 403/404 silently', async () => {
    fetchResponder = () => errorResponse(404, 'not found');
    await expect(makeClient().unpinPost('p-1')).resolves.toBeUndefined();
  });

  it('unpinPost still throws on 500', async () => {
    fetchResponder = () => errorResponse(500, 'boom');
    // 500 triggers retry-then-fail — accept either rethrow or eventual error.
    await expect(makeClient().unpinPost('p-1')).rejects.toThrow();
  }, 10_000);

  it('pinPost POSTs to /posts/:id/pin', async () => {
    fetchResponder = () => jsonResponse({});
    await makeClient().pinPost('p-1');
    expect(fetchCalls[0].method).toBe('POST');
    expect(fetchCalls[0].url).toContain('/posts/p-1/pin');
  });

  it('getPinnedPosts returns the order array', async () => {
    fetchResponder = () => jsonResponse({ order: ['p-1', 'p-2'], posts: {} });
    const ids = await makeClient().getPinnedPosts();
    expect(ids).toEqual(['p-1', 'p-2']);
  });

  it('getPinnedPosts returns empty array when order is missing', async () => {
    fetchResponder = () => jsonResponse({ posts: {} });
    expect(await makeClient().getPinnedPosts()).toEqual([]);
  });

  it('getThreadHistory sorts messages chronologically and filters bot posts', async () => {
    // Use a client and prime its bot user id via getBotUser.
    const c = makeClient();
    const responders: Record<string, Response> = {
      '/users/me': jsonResponse({ id: 'bot-id', username: 'claude', email: '', first_name: '' }),
      '/posts/thread-1/thread': jsonResponse({
        order: ['p-1', 'p-2', 'p-bot'],
        posts: {
          'p-1': { id: 'p-1', channel_id: 'c', user_id: 'u-alice', message: 'first', root_id: '', create_at: 300 },
          'p-2': { id: 'p-2', channel_id: 'c', user_id: 'u-alice', message: 'second', root_id: '', create_at: 100 },
          'p-bot': { id: 'p-bot', channel_id: 'c', user_id: 'bot-id', message: 'bot reply', root_id: '', create_at: 200 },
        },
      }),
      '/users/u-alice': jsonResponse({ id: 'u-alice', username: 'alice', email: '', first_name: 'Alice' }),
    };
    fetchResponder = (url) => {
      for (const [suffix, response] of Object.entries(responders)) {
        if (url.includes(suffix)) return response.clone();
      }
      return jsonResponse({});
    };

    await c.getBotUser();
    const history = await c.getThreadHistory('thread-1', { excludeBotMessages: true });
    expect(history.map(m => m.id)).toEqual(['p-2', 'p-1']);
    expect(history.every(m => m.username === 'alice')).toBe(true);
  });

  it('getThreadHistory respects limit (returns most recent N)', async () => {
    const c = makeClient();
    fetchResponder = (url) => {
      if (url.includes('/users/me')) return jsonResponse({ id: 'b', username: 'c', email: '', first_name: '' });
      if (url.includes('/posts/t/thread')) {
        return jsonResponse({
          order: ['a', 'b', 'c'],
          posts: {
            a: { id: 'a', channel_id: '', user_id: 'u', message: '1', root_id: '', create_at: 1 },
            b: { id: 'b', channel_id: '', user_id: 'u', message: '2', root_id: '', create_at: 2 },
            c: { id: 'c', channel_id: '', user_id: 'u', message: '3', root_id: '', create_at: 3 },
          },
        });
      }
      if (url.includes('/users/u')) return jsonResponse({ id: 'u', username: 'u', email: '', first_name: '' });
      return jsonResponse({});
    };
    await c.getBotUser();
    const limited = await c.getThreadHistory('t', { limit: 2 });
    expect(limited.map(m => m.id)).toEqual(['b', 'c']);
  });

  it('getThreadHistory returns [] on API error', async () => {
    fetchResponder = () => errorResponse(500);
    const c = makeClient();
    const history = await c.getThreadHistory('t');
    expect(history).toEqual([]);
  }, 10_000);

  it('getUser caches by user id', async () => {
    const c = makeClient();
    let calls = 0;
    fetchResponder = (url) => {
      if (url.includes('/users/u-1')) {
        calls += 1;
        return jsonResponse({ id: 'u-1', username: 'alice', email: '', first_name: '' });
      }
      return jsonResponse({});
    };
    const first = await c.getUser('u-1');
    const second = await c.getUser('u-1');
    expect(first?.username).toBe('alice');
    expect(second?.username).toBe('alice');
    expect(calls).toBe(1);
  });

  it('getUser returns null on 404', async () => {
    const c = makeClient();
    fetchResponder = () => errorResponse(404);
    expect(await c.getUser('u-missing')).toBeNull();
  }, 10_000);

  it('downloadFile returns a Buffer', async () => {
    fetchResponder = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    const buf = await makeClient().downloadFile('f-1');
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(3);
  });

  it('downloadFile throws on non-200', async () => {
    fetchResponder = () => errorResponse(403, 'forbidden');
    await expect(makeClient().downloadFile('f-1')).rejects.toThrow(/403/);
  });

  it('api retries on 500 with backoff', async () => {
    let attempts = 0;
    fetchResponder = (_url, _init) => {
      attempts += 1;
      if (attempts < 3) return errorResponse(500, 'transient');
      return jsonResponse({
        id: 'p', channel_id: 'c', user_id: 'u', message: 'ok', root_id: '', create_at: 1,
      });
    };
    const post = await makeClient().createPost('hi');
    expect(post.message).toBe('ok');
    expect(attempts).toBe(3);
  }, 10_000);
});

// -----------------------------------------------------------------------------
// allChannels mode
// -----------------------------------------------------------------------------

/** Feed a raw 'posted' websocket event into the (private) intake handler. */
function injectPostedEvent(
  client: MattermostClient,
  post: { id: string; channel_id: string; user_id: string; message: string; root_id?: string },
): void {
  (client as unknown as { handleEvent(e: unknown): void }).handleEvent({
    event: 'posted',
    data: { post: JSON.stringify({ create_at: 1000, root_id: '', ...post }) },
  });
}

describe('MattermostClient allChannels', () => {
  it('default mode drops posts from foreign channels at intake', async () => {
    const c = makeClient(); // allChannels unset
    const seen: string[] = [];
    c.on('message', (p) => seen.push(p.id));
    injectPostedEvent(c, { id: 'p-f', channel_id: 'c-other', user_id: 'u1', message: 'yo' });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(0);
  });

  it('allChannels accepts posts from foreign channels at intake', async () => {
    fetchResponder = () =>
      jsonResponse({ id: 'u1', username: 'alice' }); // getUser lookup
    const c = makeClient({ allChannels: true });
    const seen: string[] = [];
    c.on('message', (p) => seen.push(p.id));
    injectPostedEvent(c, { id: 'p-f', channel_id: 'c-other', user_id: 'u1', message: 'yo' });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(['p-f']);
  });

  it('createPost routes replies to the channel learned at intake', async () => {
    fetchResponder = (url) => {
      if (url.includes('/users/')) return jsonResponse({ id: 'u1', username: 'alice' });
      return jsonResponse({
        id: 'p-reply', channel_id: 'c-other', user_id: 'bot', message: 'hi', root_id: 'p-f', create_at: 2,
      });
    };
    const c = makeClient({ allChannels: true });
    // Root post in a foreign channel arrives → indexed.
    injectPostedEvent(c, { id: 'p-f', channel_id: 'c-other', user_id: 'u1', message: '@claude hi' });
    await new Promise((r) => setTimeout(r, 10));

    await c.createPost('reply', 'p-f');
    const postCall = fetchCalls.find((f) => f.url.endsWith('/posts') && f.method === 'POST');
    expect(postCall).toBeDefined();
    expect((postCall!.body as Record<string, unknown>).channel_id).toBe('c-other');
    expect((postCall!.body as Record<string, unknown>).root_id).toBe('p-f');
  });

  it('createPost falls back to a post lookup for roots never seen at intake', async () => {
    fetchResponder = (url) => {
      if (url.includes('/posts/p-unseen') ) {
        return jsonResponse({
          id: 'p-unseen', channel_id: 'c-resumed', user_id: 'u1', message: 'x', root_id: '', create_at: 1,
        });
      }
      return jsonResponse({
        id: 'p-r', channel_id: 'c-resumed', user_id: 'bot', message: 'hi', root_id: 'p-unseen', create_at: 2,
      });
    };
    const c = makeClient({ allChannels: true });
    await c.createPost('reply after restart', 'p-unseen');
    const postCall = fetchCalls.find((f) => f.url.endsWith('/posts') && f.method === 'POST');
    expect((postCall!.body as Record<string, unknown>).channel_id).toBe('c-resumed');
  });

  it('createPost without allChannels keeps the home channel (no lookup)', async () => {
    fetchResponder = () =>
      jsonResponse({ id: 'p', channel_id: 'c-123', user_id: 'bot', message: 'hi', root_id: 't', create_at: 1 });
    await makeClient().createPost('reply', 'thread-unknown');
    expect(fetchCalls).toHaveLength(1); // no GET /posts lookup
    expect((fetchCalls[0].body as Record<string, unknown>).channel_id).toBe('c-123');
  });

  it('home-channel posts still set the recovery baseline; foreign posts do not', async () => {
    fetchResponder = () => jsonResponse({ id: 'u1', username: 'alice' });
    const c = makeClient({ allChannels: true });
    injectPostedEvent(c, { id: 'p-foreign', channel_id: 'c-other', user_id: 'u1', message: 'a' });
    expect((c as unknown as { lastProcessedPostId: string | null }).lastProcessedPostId).toBeNull();
    injectPostedEvent(c, { id: 'p-home', channel_id: 'c-123', user_id: 'u1', message: 'b' });
    expect((c as unknown as { lastProcessedPostId: string | null }).lastProcessedPostId).toBe('p-home');
  });
});

describe('MattermostClient channel-target replies', () => {
  it('home channelId as reply target posts at home channel root (no root_id)', async () => {
    fetchResponder = () =>
      jsonResponse({ id: 'p', channel_id: 'c-123', user_id: 'bot', message: 'm', root_id: '', create_at: 1 });
    await makeClient().createPost('channel-mode reply', 'c-123');
    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.channel_id).toBe('c-123');
    expect(body.root_id).toBeUndefined();
  });

  it('foreign channelId target (learned at intake) posts at that channel root', async () => {
    fetchResponder = (url) => {
      if (url.includes('/users/')) return jsonResponse({ id: 'u1', username: 'alice' });
      return jsonResponse({ id: 'p', channel_id: 'c-other', user_id: 'bot', message: 'm', root_id: '', create_at: 2 });
    };
    const c = makeClient({ allChannels: true });
    injectPostedEvent(c, { id: 'p-f', channel_id: 'c-other', user_id: 'u1', message: '@claude hi' });
    await new Promise((r) => setTimeout(r, 10));

    await c.createPost('channel-mode reply', 'c-other');
    const postCall = fetchCalls.find((f) => f.url.endsWith('/posts') && f.method === 'POST');
    const body = postCall!.body as Record<string, unknown>;
    expect(body.channel_id).toBe('c-other');
    expect(body.root_id).toBeUndefined();
  });

  it('unseen foreign channelId target resolves via GET /channels fallback', async () => {
    fetchResponder = (url) => {
      if (url.includes('/posts/c-resumed')) return errorResponse(404, 'not a post');
      if (url.endsWith('/channels/c-resumed')) return jsonResponse({ id: 'c-resumed' });
      return jsonResponse({ id: 'p', channel_id: 'c-resumed', user_id: 'bot', message: 'm', root_id: '', create_at: 2 });
    };
    const c = makeClient({ allChannels: true });
    await c.createPost('reply after restart', 'c-resumed');
    const postCall = fetchCalls.find((f) => f.url.endsWith('/posts') && f.method === 'POST');
    const body = postCall!.body as Record<string, unknown>;
    expect(body.channel_id).toBe('c-resumed');
    expect(body.root_id).toBeUndefined();
  });
});

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeAgentName, resolveAgentName } from './agent-name.js';
import { ClaudeCli } from './cli.js';
import { buildRestartCliOptions } from './restart-options.js';
import type { Session } from '../session/types.js';

const base = { workingDir: '/Users/nate/code', platformId: 'mm', threadId: 't1' };

describe('makeAgentName', () => {
  test('channel-mode session is named exactly after the channel', () => {
    expect(makeAgentName({ ...base, channelName: 'nook-dev', channelMode: true })).toBe('nook-dev');
  });

  test('thread session gets the channel name plus a stable thread hex', () => {
    const name = makeAgentName({ ...base, channelName: 'nook-dev' });
    expect(name).toMatch(/^nook-dev-[0-9a-f]{3}$/);
    expect(makeAgentName({ ...base, channelName: 'nook-dev' })).toBe(name);
    expect(makeAgentName({ ...base, threadId: 't2', channelName: 'nook-dev' })).not.toBe(name);
  });

  test('slugs channel names', () => {
    expect(makeAgentName({ ...base, channelName: 'Nook Dev!', channelMode: true })).toBe('nook-dev');
  });

  test('falls back to <dir>-<hex> without a channel name', () => {
    expect(makeAgentName(base)).toMatch(/^code-[0-9a-f]{3}$/);
    expect(makeAgentName({ ...base, workingDir: '/' })).toMatch(/^agent-[0-9a-f]{3}$/);
  });
});

describe('resolveAgentName', () => {
  test('uses the platform channel name', async () => {
    const platform = { getChannelName: async () => 'dm-tixnow' };
    expect(await resolveAgentName(platform, { ...base, channelId: 'c', channelMode: true })).toBe('dm-tixnow');
  });

  test('falls back when the platform cannot look it up', async () => {
    expect(await resolveAgentName({}, { ...base, channelId: 'c' })).toMatch(/^code-/);
    expect(await resolveAgentName({ getChannelName: async () => null }, { ...base, channelId: 'c' })).toMatch(/^code-/);
    const throws = { getChannelName: async () => { throw new Error('boom'); } };
    expect(await resolveAgentName(throws, { ...base, channelId: 'c' })).toMatch(/^code-/);
  });
});

describe('agentName reaches the claude command line', () => {
  let dir: string;
  const prevPath = process.env.CLAUDE_PATH;
  afterEach(() => {
    if (prevPath === undefined) delete process.env.CLAUDE_PATH; else process.env.CLAUDE_PATH = prevPath;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function spawnArgs(agentName?: string): Promise<string[]> {
    dir = mkdtempSync(join(tmpdir(), 'agentname-'));
    const out = join(dir, 'argv');
    const fake = join(dir, 'fake-claude.sh');
    writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${out}'\n`);
    chmodSync(fake, 0o755);
    process.env.CLAUDE_PATH = fake;
    const cli = new ClaudeCli({ workingDir: dir, permissionMode: 'bypass', agentName });
    cli.start();
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, 50));
    cli.kill();
    return readFileSync(out, 'utf8').split('\n');
  }

  test('passes --name when agentName is set', async () => {
    const args = await spawnArgs('dm-tixnow');
    const i = args.indexOf('--name');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('dm-tixnow');
  });

  test('omits --name when agentName is unset', async () => {
    expect(await spawnArgs()).not.toContain('--name');
  });
});

describe('buildRestartCliOptions', () => {
  test('carries the session agentName across restarts (!cd, worktree)', () => {
    const session = {
      platformId: 'mm', threadId: 't1', sessionId: 'mm:t1', startedBy: 'u',
      agentName: 'dm-tixnow',
      platform: { getMcpConfig: () => ({}) },
    } as unknown as Session;
    expect(buildRestartCliOptions(session, { chromeEnabled: false }).agentName).toBe('dm-tixnow');
  });
});

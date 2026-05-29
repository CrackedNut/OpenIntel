import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { searchArchive, formatArchiveHits, type ArchiveSearchOptions } from './archive-search.js';

let tmpRoot: string;

function writeJsonl(path: string, lines: object[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function userMessageEntry(ts: number, sessionId: string, username: string, message: string) {
  return { ts, sessionId, type: 'user_message', username, message };
}

function lifecycleStart(ts: number, sessionId: string, threadId: string) {
  return { ts, sessionId, type: 'lifecycle', action: 'start', details: { threadId } };
}

function assistantTextEvent(ts: number, sessionId: string, text: string) {
  return {
    ts,
    sessionId,
    type: 'claude_event',
    eventType: 'assistant',
    event: { message: { content: [{ type: 'text', text }] } },
  };
}

function assistantToolUseEvent(ts: number, sessionId: string, name: string, input: object) {
  return {
    ts,
    sessionId,
    type: 'claude_event',
    eventType: 'tool_use',
    event: { message: { content: [{ type: 'tool_use', name, input }] } },
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'archive-search-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('searchArchive', () => {
  test('returns empty array for empty query', () => {
    expect(searchArchive({ query: '', archiveDir: tmpRoot })).toEqual([]);
    expect(searchArchive({ query: '   ', archiveDir: tmpRoot })).toEqual([]);
  });

  test('returns empty array when archive dir does not exist', () => {
    expect(searchArchive({ query: 'foo', archiveDir: join(tmpRoot, 'nope') })).toEqual([]);
  });

  test('matches a substring in a user message', () => {
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeJsonl(join(tmpRoot, 'mm', `${sid}.jsonl`), [
      lifecycleStart(1, sid, 'thread1'),
      userMessageEntry(2, sid, 'alice', 'remember the secret password is bananas'),
      userMessageEntry(3, sid, 'alice', 'unrelated chatter about cats'),
    ]);
    const hits = searchArchive({ query: 'bananas', archiveDir: tmpRoot });
    expect(hits.length).toBe(1);
    expect(hits[0].snippet).toContain('bananas');
    expect(hits[0].username).toBe('alice');
    expect(hits[0].role).toBe('user');
    expect(hits[0].platformId).toBe('mm');
    expect(hits[0].sessionId).toBe(sid);
    expect(hits[0].threadId).toBe('thread1');
  });

  test('is case-insensitive', () => {
    const sid = 'sess-1';
    writeJsonl(join(tmpRoot, 'mm', `${sid}.jsonl`), [
      lifecycleStart(1, sid, 'thread1'),
      userMessageEntry(2, sid, 'alice', 'HELLO WORLD'),
    ]);
    expect(searchArchive({ query: 'hello', archiveDir: tmpRoot })).toHaveLength(1);
    expect(searchArchive({ query: 'WORLD', archiveDir: tmpRoot })).toHaveLength(1);
  });

  test('matches text inside assistant content blocks', () => {
    const sid = 'sess-2';
    writeJsonl(join(tmpRoot, 'mm', `${sid}.jsonl`), [
      lifecycleStart(1, sid, 'thread1'),
      assistantTextEvent(2, sid, 'I will help you debug the OAuth flow'),
    ]);
    const hits = searchArchive({ query: 'oauth flow', archiveDir: tmpRoot });
    expect(hits).toHaveLength(1);
    expect(hits[0].role).toBe('assistant');
  });

  test('matches tool name and input JSON', () => {
    const sid = 'sess-3';
    writeJsonl(join(tmpRoot, 'mm', `${sid}.jsonl`), [
      lifecycleStart(1, sid, 'thread1'),
      assistantToolUseEvent(2, sid, 'Bash', { command: 'git status --porcelain' }),
    ]);
    const byName = searchArchive({ query: 'Bash', archiveDir: tmpRoot });
    expect(byName).toHaveLength(1);
    expect(byName[0].role).toBe('tool_use');

    const byInput = searchArchive({ query: 'porcelain', archiveDir: tmpRoot });
    expect(byInput).toHaveLength(1);
  });

  test('thread scope only returns hits from the matching thread', () => {
    const sidA = 'sess-A';
    const sidB = 'sess-B';
    writeJsonl(join(tmpRoot, 'mm', `${sidA}.jsonl`), [
      lifecycleStart(1, sidA, 'thread1'),
      userMessageEntry(2, sidA, 'alice', 'pizza party'),
    ]);
    writeJsonl(join(tmpRoot, 'mm', `${sidB}.jsonl`), [
      lifecycleStart(1, sidB, 'thread2'),
      userMessageEntry(2, sidB, 'bob', 'pizza place'),
    ]);

    const opts: ArchiveSearchOptions = {
      query: 'pizza',
      archiveDir: tmpRoot,
      platformId: 'mm',
      threadId: 'thread1',
      scope: 'thread',
    };
    const hits = searchArchive(opts);
    expect(hits).toHaveLength(1);
    expect(hits[0].threadId).toBe('thread1');
    expect(hits[0].sessionId).toBe(sidA);
  });

  test('platform scope returns hits from any thread on that platform', () => {
    writeJsonl(join(tmpRoot, 'mm', 'sA.jsonl'), [
      lifecycleStart(1, 'sA', 't1'),
      userMessageEntry(2, 'sA', 'alice', 'pizza party'),
    ]);
    writeJsonl(join(tmpRoot, 'slack', 'sB.jsonl'), [
      lifecycleStart(1, 'sB', 't2'),
      userMessageEntry(2, 'sB', 'bob', 'pizza place'),
    ]);

    const opts: ArchiveSearchOptions = {
      query: 'pizza',
      archiveDir: tmpRoot,
      platformId: 'mm',
      scope: 'platform',
    };
    const hits = searchArchive(opts);
    expect(hits).toHaveLength(1);
    expect(hits[0].platformId).toBe('mm');
  });

  test('all scope crosses platforms', () => {
    writeJsonl(join(tmpRoot, 'mm', 'sA.jsonl'), [
      lifecycleStart(1, 'sA', 't1'),
      userMessageEntry(2, 'sA', 'alice', 'pizza party'),
    ]);
    writeJsonl(join(tmpRoot, 'slack', 'sB.jsonl'), [
      lifecycleStart(1, 'sB', 't2'),
      userMessageEntry(2, 'sB', 'bob', 'pizza place'),
    ]);

    const hits = searchArchive({ query: 'pizza', archiveDir: tmpRoot, scope: 'all' });
    expect(hits.length).toBe(2);
    const platforms = new Set(hits.map(h => h.platformId));
    expect(platforms.has('mm')).toBe(true);
    expect(platforms.has('slack')).toBe(true);
  });

  test('respects limit', () => {
    const sid = 'sess-many';
    const lines: object[] = [lifecycleStart(1, sid, 't1')];
    for (let i = 0; i < 20; i++) {
      lines.push(userMessageEntry(2 + i, sid, 'alice', `match ${i}`));
    }
    writeJsonl(join(tmpRoot, 'mm', `${sid}.jsonl`), lines);
    const hits = searchArchive({ query: 'match', archiveDir: tmpRoot, limit: 5 });
    expect(hits.length).toBe(5);
  });

  test('hits sorted newest first', () => {
    const sid = 'sess-ord';
    writeJsonl(join(tmpRoot, 'mm', `${sid}.jsonl`), [
      lifecycleStart(1, sid, 't1'),
      userMessageEntry(100, sid, 'alice', 'token alpha'),
      userMessageEntry(300, sid, 'alice', 'token gamma'),
      userMessageEntry(200, sid, 'alice', 'token beta'),
    ]);
    const hits = searchArchive({ query: 'token', archiveDir: tmpRoot });
    expect(hits.map(h => h.ts)).toEqual([300, 200, 100]);
  });

  test('skips unparseable lines without throwing', () => {
    const sid = 'sess-bad';
    const path = join(tmpRoot, 'mm', `${sid}.jsonl`);
    mkdirSync(join(tmpRoot, 'mm'), { recursive: true });
    const good = JSON.stringify(userMessageEntry(2, sid, 'alice', 'good entry'));
    writeFileSync(
      path,
      `${JSON.stringify(lifecycleStart(1, sid, 't1'))}\n` +
      `not-json garbage\n` +
      `${good}\n` +
      `{"truncated":\n`,
    );
    const hits = searchArchive({ query: 'good entry', archiveDir: tmpRoot });
    expect(hits).toHaveLength(1);
  });

  test('clamps limit to MAX_LIMIT (50)', () => {
    const sid = 'sess-big';
    const lines: object[] = [lifecycleStart(1, sid, 't1')];
    for (let i = 0; i < 200; i++) lines.push(userMessageEntry(2 + i, sid, 'a', `m${i}`));
    writeJsonl(join(tmpRoot, 'mm', `${sid}.jsonl`), lines);
    const hits = searchArchive({ query: 'm', archiveDir: tmpRoot, limit: 9999 });
    expect(hits.length).toBe(50);
  });
});

describe('formatArchiveHits', () => {
  test('returns "no matches" line on empty hits', () => {
    expect(formatArchiveHits('foo', [])).toContain('No archive matches');
    expect(formatArchiveHits('foo', [])).toContain('`foo`');
  });

  test('renders one block per hit with iso ts + author + snippet', () => {
    const out = formatArchiveHits('pizza', [
      {
        ts: Date.UTC(2026, 4, 28, 12, 30),
        platformId: 'mm',
        threadId: 'thread-xyz1234567890',
        sessionId: 'aaaaaaaa-bbbb',
        role: 'user',
        username: 'alice',
        snippet: 'pizza party tonight',
      },
    ]);
    expect(out).toContain('2026-05-28 12:30');
    expect(out).toContain('@alice');
    expect(out).toContain('pizza party tonight');
    expect(out).toContain('Archive matches for `pizza` (1)');
  });
});

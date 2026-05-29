/**
 * Archive Search — substring search over thread-logger JSONL archives.
 *
 * Reads `~/.claude-threads/logs/{platformId}/{claudeSessionId}.jsonl` files
 * (written by `ThreadLogger`) and returns matches against user messages and
 * Claude assistant text blocks. No FTS — case-insensitive substring is good
 * enough for chat-volume archives at the retention window the bot enforces
 * (default 30 days; configurable via `threadLogs.retentionDays`).
 *
 * Used by:
 *   - `!search <query>` command — surfaces hits in the current thread
 *   - `search_archive` MCP tool — lets Claude grep its own history mid-task
 *
 * Both callers scope by platform/thread when they can; cross-thread search
 * is opt-in (`scope: 'platform'` or `'all'`) so chat content from another
 * user's thread can only leak when the operator explicitly broadens scope.
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../utils/logger.js';

const log = createLogger('archive-search');

export const DEFAULT_ARCHIVE_DIR = join(homedir(), '.claude-threads', 'logs');

export type ArchiveScope = 'thread' | 'platform' | 'all';

export interface ArchiveSearchOptions {
  /** Substring query, case-insensitive. Required, non-empty. */
  query: string;
  /** Scope of the search. Default `'thread'` when threadId is known, else `'all'`. */
  scope?: ArchiveScope;
  /** Bot platform ID. Required for `thread` and `platform` scope. */
  platformId?: string;
  /** Thread ID. Required for `thread` scope. */
  threadId?: string;
  /** Max hits to return. Default 10, max 50. */
  limit?: number;
  /** Override the archive root (tests). Default `~/.claude-threads/logs`. */
  archiveDir?: string;
}

export interface ArchiveHit {
  /** When the matching entry was logged (epoch ms). */
  ts: number;
  /** Platform the session ran on. */
  platformId: string;
  /** Thread ID the session was attached to. */
  threadId: string;
  /** Claude session ID — also the JSONL filename without extension. */
  sessionId: string;
  /** 'user' for user messages, 'assistant' / 'tool_use' for Claude events. */
  role: 'user' | 'assistant' | 'tool_use';
  /** Sender username (only for user messages). */
  username?: string;
  /** The matched text — truncated to 300 chars around the hit. */
  snippet: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SNIPPET_RADIUS = 120;

function clampLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Pull a snippet around the first case-insensitive match of `query` in
 * `text`. Returns the whole string when it's short, otherwise `…<context>…`.
 */
function snippetAroundMatch(text: string, query: string): string {
  if (text.length <= SNIPPET_RADIUS * 2) return text.trim();
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, SNIPPET_RADIUS * 2).trim() + '…';
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + query.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).trim() + suffix;
}

/**
 * Extract searchable text from a single JSONL log line. Returns null when
 * the line is not a content-bearing entry, or when JSON parsing fails.
 */
function extractContent(
  line: string,
): { ts: number; role: ArchiveHit['role']; text: string; username?: string; threadIdHint?: string } | null {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const ts = typeof entry.ts === 'number' ? entry.ts : 0;
  const type = entry.type;

  if (type === 'user_message') {
    const text = typeof entry.message === 'string' ? entry.message : '';
    if (!text) return null;
    return {
      ts,
      role: 'user',
      text,
      username: typeof entry.username === 'string' ? entry.username : undefined,
    };
  }

  if (type === 'claude_event') {
    const event = entry.event as Record<string, unknown> | undefined;
    if (!event || typeof event !== 'object') return null;
    const eventType = entry.eventType;
    const role: ArchiveHit['role'] = eventType === 'tool_use' ? 'tool_use' : 'assistant';

    // Assistant events have shape { message: { content: [{type, text}, ...] } }
    const message = (event as { message?: { content?: Array<Record<string, unknown>> } }).message;
    if (message && Array.isArray(message.content)) {
      const texts: string[] = [];
      for (const block of message.content) {
        if (block && typeof block === 'object') {
          if (typeof block.text === 'string' && block.text.length > 0) {
            texts.push(block.text);
          }
          // Tool-use blocks: include the tool name + JSON-stringified input so
          // queries like "Bash" or a flag value find the actual call site.
          if (block.type === 'tool_use') {
            const name = typeof block.name === 'string' ? block.name : '';
            const input = block.input !== undefined ? JSON.stringify(block.input) : '';
            if (name || input) texts.push(`[tool:${name}] ${input}`);
          }
        }
      }
      const joined = texts.join('\n');
      if (joined) return { ts, role, text: joined };
    }

    // Fall back to raw event JSON (covers system/result events with embedded
    // text but no canonical content array).
    if (eventType === 'result' || eventType === 'system') return null;
    return null;
  }

  return null;
}

/**
 * Parse the threadId out of the log path. ThreadLogger writes to
 * `{archiveDir}/{platformId}/{claudeSessionId}.jsonl` — threadId is NOT in
 * the path, only in lifecycle entries inside the file. So to scope by
 * threadId we must peek at the file's `lifecycle:start` entry, which carries
 * the threadId in its `details`.
 */
function readThreadIdFromFile(filePath: string): string | null {
  try {
    // Threadid lives in the first lifecycle entry; read just the head.
    const content = readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === 'lifecycle' && entry.action === 'start') {
          const details = entry.details as Record<string, unknown> | undefined;
          const tid = details?.threadId;
          if (typeof tid === 'string') return tid;
        }
      } catch {
        continue;
      }
    }
  } catch (err) {
    log.debug(`Failed to read thread id from ${filePath}: ${(err as Error).message}`);
  }
  return null;
}

interface CandidateFile {
  path: string;
  sessionId: string;
  platformId: string;
}

function collectFiles(
  archiveDir: string,
  scope: ArchiveScope,
  platformId: string | undefined,
): CandidateFile[] {
  if (!existsSync(archiveDir)) return [];
  const files: CandidateFile[] = [];

  const platformDirs: string[] = [];
  if (scope === 'all' || !platformId) {
    try {
      const entries = readdirSync(archiveDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) platformDirs.push(e.name);
      }
    } catch (err) {
      log.debug(`Failed to list archive dir ${archiveDir}: ${(err as Error).message}`);
      return [];
    }
  } else {
    platformDirs.push(platformId);
  }

  for (const pid of platformDirs) {
    const dir = join(archiveDir, pid);
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        files.push({
          path: join(dir, e.name),
          sessionId: e.name.replace(/\.jsonl$/, ''),
          platformId: pid,
        });
      }
    } catch (err) {
      log.debug(`Failed to list ${dir}: ${(err as Error).message}`);
    }
  }

  // Newest first — chat search wants recency.
  files.sort((a, b) => {
    try {
      return statSync(b.path).mtimeMs - statSync(a.path).mtimeMs;
    } catch {
      return 0;
    }
  });
  return files;
}

/**
 * Run the search. Synchronous file IO under the hood — fine for chat-volume
 * archives. If we ever hit performance issues, swap in a Bun:File stream or
 * a worker; the API doesn't change.
 */
export function searchArchive(opts: ArchiveSearchOptions): ArchiveHit[] {
  const query = opts.query?.trim() ?? '';
  if (!query) return [];

  const archiveDir = opts.archiveDir ?? DEFAULT_ARCHIVE_DIR;
  const limit = clampLimit(opts.limit);
  const scope: ArchiveScope = opts.scope ?? (opts.threadId ? 'thread' : opts.platformId ? 'platform' : 'all');

  const candidates = collectFiles(archiveDir, scope, opts.platformId);
  if (candidates.length === 0) return [];

  const needleLower = query.toLowerCase();
  const hits: ArchiveHit[] = [];

  outer: for (const file of candidates) {
    // Scope=thread filter: only files whose lifecycle:start matches the
    // requested threadId.
    let threadIdForFile: string | null = null;
    if (scope === 'thread') {
      threadIdForFile = readThreadIdFromFile(file.path);
      if (threadIdForFile !== opts.threadId) continue;
    }

    let content: string;
    try {
      content = readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      if (!line) continue;
      const extracted = extractContent(line);
      if (!extracted) continue;
      if (!extracted.text.toLowerCase().includes(needleLower)) continue;

      // Resolve threadId lazily — for scope=platform/all we still want it on
      // the hit so the UI can link back, but we only read it once per file.
      if (threadIdForFile === null) {
        threadIdForFile = readThreadIdFromFile(file.path) ?? '';
      }

      hits.push({
        ts: extracted.ts,
        platformId: file.platformId,
        threadId: threadIdForFile,
        sessionId: file.sessionId,
        role: extracted.role,
        username: extracted.username,
        snippet: snippetAroundMatch(extracted.text, query),
      });

      if (hits.length >= limit) break outer;
    }
  }

  // Newest hit first.
  hits.sort((a, b) => b.ts - a.ts);
  return hits;
}

/**
 * Format hits as a plain-text block suitable for posting to a chat thread
 * or returning to Claude. Uses a markdown-ish format that survives both
 * Mattermost and Slack.
 */
export function formatArchiveHits(query: string, hits: ArchiveHit[]): string {
  if (hits.length === 0) return `No archive matches for \`${query}\`.`;

  const lines: string[] = [];
  lines.push(`Archive matches for \`${query}\` (${hits.length}):`);
  lines.push('');
  for (const hit of hits) {
    const when = new Date(hit.ts).toISOString().replace('T', ' ').slice(0, 16);
    const who = hit.username ? `@${hit.username}` : hit.role;
    lines.push(`**${when}** · ${who} · session \`${hit.sessionId.slice(0, 8)}\` · thread \`${hit.threadId.slice(0, 12)}\``);
    lines.push(`> ${hit.snippet.replace(/\n/g, '\n> ')}`);
    lines.push('');
  }
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

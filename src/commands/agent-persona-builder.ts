/**
 * Agent Persona Builder — Hermes-style "Tier 1 stable" content.
 *
 * Reads up to three optional file-based layers and concatenates them into
 * a single string that gets prepended to Claude's `--append-system-prompt`:
 *
 *   1. DIRECTIVES.md — immutable behavioral loops (read-only guardrails).
 *   2. SOUL.md       — persona / identity / tone.
 *   3. Projects index — one-line summary per project, auto-built from
 *      `<projectsIndexDir>/<project>/description.md` files.
 *
 * All layers are optional. Missing files are silently skipped — the Hermes
 * defaults (`~/.hermes/SOUL.md`, `~/.hermes/DIRECTIVES.md`,
 * `~/agent-memory/projects/`) are only present on machines with a Hermes
 * install, so it's normal for them to be absent.
 *
 * Reads are synchronous + cached on the file path. The cache is keyed by
 * absolute path + mtime so manual edits to SOUL.md surface on the next
 * session spawn without a bot restart.
 *
 * The output is stable for the lifetime of the underlying files, so callers
 * can pass it straight to `buildAppendSystemPrompt` — it lives in the
 * "stable" layer of the appended prompt, before the session context line,
 * to maximize prefix-cache hits on the upstream API.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { AgentPersonaConfig } from '../config/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('agent-persona');

const DEFAULT_SOUL_PATH = join(homedir(), '.hermes', 'SOUL.md');
const DEFAULT_DIRECTIVES_PATH = join(homedir(), '.hermes', 'DIRECTIVES.md');
const DEFAULT_PROJECTS_DIR = join(homedir(), 'agent-memory', 'projects');

interface CacheEntry {
  mtimeMs: number;
  content: string;
}
const fileCache = new Map<string, CacheEntry>();

function readFileCached(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    const cached = fileCache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content;
    const content = readFileSync(path, 'utf8').trim();
    fileCache.set(path, { mtimeMs: stat.mtimeMs, content });
    return content;
  } catch (err) {
    log.debug(`Failed to read ${path}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Build the projects index by scanning subdirs of `dir` for `description.md`
 * files. Each project produces one bullet:
 *
 *   - **project-name** — first non-empty line of description.md
 *
 * Returns null when the dir doesn't exist or contains no projects.
 */
function buildProjectsIndex(dir: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
    const lines: string[] = [];
    for (const name of entries) {
      const descPath = join(dir, name, 'description.md');
      const content = readFileCached(descPath);
      if (!content) continue;
      const firstLine = content.split('\n').find(l => l.trim().length > 0)?.trim();
      if (!firstLine) continue;
      lines.push(`- **${name}** — ${firstLine}`);
    }
    if (lines.length === 0) return null;
    return `## Projects Index\n\nProjects tracked in agent memory (one-line summary per project):\n\n${lines.join('\n')}`;
  } catch (err) {
    log.debug(`Failed to build projects index from ${dir}: ${(err as Error).message}`);
    return null;
  }
}

function resolvePath(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return resolve(p);
}

/**
 * Assemble the persona text. Returns an empty string when the feature is
 * disabled or every layer is missing — callers can treat the result as
 * "prepend if non-empty".
 *
 * Layer order matches Hermes' system_prompt.py: directives first (immutable
 * loops), then soul (identity), then projects index. Joined with `\n\n`.
 */
export function buildAgentPersonaText(config?: AgentPersonaConfig): string {
  if (!config || config.enabled === false) return '';

  const soulPath = config.soulPath ? resolvePath(config.soulPath) : DEFAULT_SOUL_PATH;
  const directivesPath = config.directivesPath
    ? resolvePath(config.directivesPath)
    : DEFAULT_DIRECTIVES_PATH;
  const projectsDir = config.projectsIndexDir
    ? resolvePath(config.projectsIndexDir)
    : DEFAULT_PROJECTS_DIR;

  const parts: string[] = [];

  const directives = readFileCached(directivesPath);
  if (directives) parts.push(directives);

  const soul = readFileCached(soulPath);
  if (soul) parts.push(soul);

  const projectsIndex = buildProjectsIndex(projectsDir);
  if (projectsIndex) parts.push(projectsIndex);

  return parts.join('\n\n');
}

/** Clear the file cache. Exposed for tests; not used at runtime. */
export function _clearAgentPersonaCache(): void {
  fileCache.clear();
}

/**
 * Skills Index Builder — Hermes-style "available skills" prepend.
 *
 * Scans `<skillsDir>/<skill-name>/SKILL.md` files and produces a single
 * markdown block listing every skill's name + description (the
 * `description:` field from the YAML frontmatter):
 *
 *   ## Available skills
 *
 *   - **skill-name** — first line of the description.
 *
 * The output is concatenated into Claude's `--append-system-prompt` so the
 * model knows what skills exist before it has to search for them. Mirrors
 * the cache-friendly pattern in `agent-persona-builder.ts`: synchronous,
 * mtime-keyed in-memory cache, safe to call on every spawn.
 *
 * Default skills dir: `~/.claude/skills`. Missing dir → empty string.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { SkillsIndexConfig } from '../config/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('skills-index');

const DEFAULT_SKILLS_DIR = join(homedir(), '.claude', 'skills');

interface CacheEntry {
  mtimeMs: number;
  description: string | null;
}
const skillCache = new Map<string, CacheEntry>();

/**
 * Parse the `description:` field out of a SKILL.md's YAML frontmatter.
 *
 * Deliberately tiny — no YAML dep. Looks for the first `---` fenced block at
 * the top of the file and extracts the value of `description:` from it,
 * stripping surrounding single/double quotes. Returns null if no frontmatter,
 * no description line, or the file isn't a SKILL.md shape we recognize.
 */
function parseDescription(content: string): string | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const frontmatter = content.slice(3, end);
  const lines = frontmatter.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^description:\s*(.*)$/);
    if (!m) continue;
    let value = m[1].trim();
    // Handle block-scalar (`|` or `>`): take subsequent indented lines.
    if (value === '|' || value === '>') {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (!/^\s+/.test(lines[j])) break;
        parts.push(lines[j].trim());
      }
      value = parts.join(' ');
    }
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Collapse internal whitespace + first line only (descriptions sometimes
    // wrap across multiple lines in the source; the system-prompt block
    // wants a single line per skill).
    value = value.replace(/\s+/g, ' ').trim();
    return value || null;
  }
  return null;
}

function readSkillDescription(skillMdPath: string): string | null {
  if (!existsSync(skillMdPath)) return null;
  try {
    const stat = statSync(skillMdPath);
    const cached = skillCache.get(skillMdPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.description;
    const content = readFileSync(skillMdPath, 'utf8');
    const description = parseDescription(content);
    skillCache.set(skillMdPath, { mtimeMs: stat.mtimeMs, description });
    return description;
  } catch (err) {
    log.debug(`Failed to read ${skillMdPath}: ${(err as Error).message}`);
    return null;
  }
}

function resolvePath(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return resolve(p);
}

/**
 * Build the skills index block. Empty string when disabled, when the skills
 * dir is missing, or when no skill exposes a description — callers can treat
 * the result as "prepend if non-empty".
 */
export function buildSkillsIndexText(config?: SkillsIndexConfig): string {
  if (config?.enabled === false) return '';

  const skillsDir = config?.skillsDir ? resolvePath(config.skillsDir) : DEFAULT_SKILLS_DIR;
  if (!existsSync(skillsDir)) return '';

  let entries: string[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
  } catch (err) {
    log.debug(`Failed to list skills dir ${skillsDir}: ${(err as Error).message}`);
    return '';
  }

  const lines: string[] = [];
  for (const name of entries) {
    const skillMd = join(skillsDir, name, 'SKILL.md');
    const description = readSkillDescription(skillMd);
    if (!description) continue;
    lines.push(`- **${name}** — ${description}`);
  }
  if (lines.length === 0) return '';

  return `## Available skills\n\nSkills available via the Skill tool (invoke by name when relevant):\n\n${lines.join('\n')}`;
}

/** Clear the file cache. Exposed for tests; not used at runtime. */
export function _clearSkillsIndexCache(): void {
  skillCache.clear();
}

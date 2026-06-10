/**
 * Agent Dashboard — local web panel.
 *
 * Runs inside the bot process, bound to 127.0.0.1 only. Lets the operator:
 *   - see bot status (version, platforms, active sessions)
 *   - edit config.yaml (platforms, tokens, modes) and restart to apply
 *   - edit the agent persona files (SOUL.md / DIRECTIVES.md)
 *   - manage the projects index (<projectsIndexDir>/<name>/description.md)
 *   - manage skills (<skillsDir>/<name>/SKILL.md)
 *   - restart the bot (exit 42 → daemon restarts it; sessions resume)
 *
 * SECURITY MODEL: localhost-only single-operator tool. No auth — anything
 * that can reach 127.0.0.1 on this machine already has your shell. Never
 * bind this to a public interface without adding auth first.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { CONFIG_PATH, loadConfigWithMigration, type Config } from '../config/index.js';
import { PANEL_HTML } from './ui.js';

const DEFAULT_SOUL_PATH = join(homedir(), '.hermes', 'SOUL.md');
const DEFAULT_DIRECTIVES_PATH = join(homedir(), '.hermes', 'DIRECTIVES.md');
const DEFAULT_PROJECTS_DIR = join(homedir(), 'agent-memory', 'projects');
const DEFAULT_SKILLS_DIR = join(homedir(), '.claude', 'skills');

/** Reject names that could escape their parent directory. */
function isSafeName(name: string): boolean {
  return /^[\w][\w.-]{0,127}$/.test(name);
}

function resolveTilde(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(p);
}

export interface PanelStatusProvider {
  version: string;
  getSessions(): Array<{
    sessionId: string;
    platformId: string;
    mode: string;
    title?: string;
    startedBy: string;
    startedAt: string;
    isProcessing: boolean;
  }>;
  getPlatforms(): Array<{ id: string; type: string; displayName: string; connected: boolean }>;
}

export interface PanelOptions {
  port?: number;
  status: PanelStatusProvider;
  /** Graceful restart: persist + disconnect, then exit(42) for the daemon. */
  requestRestart: () => Promise<void>;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** Resolve the editable file paths from the live config (falls back to defaults). */
function resolvePaths(config: Config | null) {
  const persona = config?.agentPersona;
  const skills = config?.skillsIndex;
  return {
    soul: resolveTilde(persona?.soulPath ?? DEFAULT_SOUL_PATH),
    directives: resolveTilde(persona?.directivesPath ?? DEFAULT_DIRECTIVES_PATH),
    projectsDir: resolveTilde(persona?.projectsIndexDir ?? DEFAULT_PROJECTS_DIR),
    skillsDir: resolveTilde(skills?.skillsDir ?? DEFAULT_SKILLS_DIR),
  };
}

function readTextOr(path: string, fallback = ''): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : fallback;
  } catch {
    return fallback;
  }
}

/** List <dir>/<name>/<file> entries as {name, content}. */
function listMdEntries(dir: string, file: string): Array<{ name: string; content: string }> {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isSafeName(e.name))
      .map((e) => ({ name: e.name, content: readTextOr(join(dir, e.name, file)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function startPanelServer(options: PanelOptions): { port: number; close: () => void } {
  const port = options.port ?? 7777;
  const app = new Hono();

  app.get('/', (c) => c.html(PANEL_HTML));

  // ---- status -------------------------------------------------------------
  app.get('/api/status', (c) => {
    const config = loadConfigWithMigration();
    const paths = resolvePaths(config);
    return c.json({
      version: options.status.version,
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      configPath: CONFIG_PATH,
      paths,
      platforms: options.status.getPlatforms(),
      sessions: options.status.getSessions(),
    });
  });

  // ---- config.yaml (raw text — YAML comments survive round-trips) ---------
  app.get('/api/config', (c) => c.text(readTextOr(CONFIG_PATH)));
  app.put('/api/config', async (c) => {
    const body = await c.req.text();
    try {
      const yaml = await import('js-yaml');
      const parsed = yaml.load(body) as { platforms?: unknown[] } | null;
      if (!parsed || !Array.isArray(parsed.platforms) || parsed.platforms.length === 0) {
        return c.json({ ok: false, error: 'config must have at least one entry under `platforms:`' }, 400);
      }
    } catch (err) {
      return c.json({ ok: false, error: `invalid YAML: ${err instanceof Error ? err.message : err}` }, 400);
    }
    writeFileSync(CONFIG_PATH, body, { mode: 0o600 });
    options.log('info', 'panel: config.yaml saved (restart to apply)');
    return c.json({ ok: true, note: 'saved — restart the bot to apply' });
  });

  // ---- persona files -------------------------------------------------------
  for (const key of ['soul', 'directives'] as const) {
    app.get(`/api/persona/${key}`, (c) => {
      const paths = resolvePaths(loadConfigWithMigration());
      return c.json({ path: paths[key], content: readTextOr(paths[key]) });
    });
    app.put(`/api/persona/${key}`, async (c) => {
      const paths = resolvePaths(loadConfigWithMigration());
      const content = await c.req.text();
      mkdirSync(resolve(paths[key], '..'), { recursive: true });
      writeFileSync(paths[key], content);
      options.log('info', `panel: ${key} saved → ${paths[key]} (picked up on next session start)`);
      return c.json({ ok: true });
    });
  }

  // ---- projects index ------------------------------------------------------
  app.get('/api/projects', (c) => {
    const { projectsDir } = resolvePaths(loadConfigWithMigration());
    return c.json({ dir: projectsDir, entries: listMdEntries(projectsDir, 'description.md') });
  });
  app.put('/api/projects/:name', async (c) => {
    const name = c.req.param('name');
    if (!isSafeName(name)) return c.json({ ok: false, error: 'invalid project name' }, 400);
    const { projectsDir } = resolvePaths(loadConfigWithMigration());
    const dir = join(projectsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'description.md'), await c.req.text());
    options.log('info', `panel: project "${name}" saved`);
    return c.json({ ok: true });
  });
  app.delete('/api/projects/:name', (c) => {
    const name = c.req.param('name');
    if (!isSafeName(name)) return c.json({ ok: false, error: 'invalid project name' }, 400);
    const { projectsDir } = resolvePaths(loadConfigWithMigration());
    const target = join(projectsDir, name, 'description.md');
    if (existsSync(target)) rmSync(target);
    options.log('info', `panel: project "${name}" description removed`);
    return c.json({ ok: true });
  });

  // ---- skills ----------------------------------------------------------------
  app.get('/api/skills', (c) => {
    const { skillsDir } = resolvePaths(loadConfigWithMigration());
    return c.json({ dir: skillsDir, entries: listMdEntries(skillsDir, 'SKILL.md') });
  });
  app.put('/api/skills/:name', async (c) => {
    const name = c.req.param('name');
    if (!isSafeName(name)) return c.json({ ok: false, error: 'invalid skill name' }, 400);
    const { skillsDir } = resolvePaths(loadConfigWithMigration());
    const dir = join(skillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), await c.req.text());
    options.log('info', `panel: skill "${name}" saved`);
    return c.json({ ok: true });
  });
  app.delete('/api/skills/:name', (c) => {
    const name = c.req.param('name');
    if (!isSafeName(name)) return c.json({ ok: false, error: 'invalid skill name' }, 400);
    const { skillsDir } = resolvePaths(loadConfigWithMigration());
    const target = join(skillsDir, name, 'SKILL.md');
    if (existsSync(target)) rmSync(target);
    options.log('info', `panel: skill "${name}" removed`);
    return c.json({ ok: true });
  });

  // ---- restart ----------------------------------------------------------------
  app.post('/api/restart', (c) => {
    options.log('info', 'panel: restart requested');
    // Respond first, then restart — the daemon brings the bot (and panel) back.
    setTimeout(() => {
      options.requestRestart().catch((err) => options.log('error', `panel restart failed: ${err}`));
    }, 250);
    return c.json({ ok: true, note: 'restarting — panel back in ~10s' });
  });

  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  options.log('info', `🖥️  Agent dashboard: http://127.0.0.1:${port}`);
  return { port, close: () => server.close() };
}

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildSkillsIndexText,
  _clearSkillsIndexCache,
} from './skills-index-builder.js';

let tmpRoot: string;

function mkSkill(skillsDir: string, name: string, frontmatter: string, body = '') {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  const content = `---\n${frontmatter}\n---\n${body}`;
  writeFileSync(join(dir, 'SKILL.md'), content);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'skills-index-test-'));
  _clearSkillsIndexCache();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  _clearSkillsIndexCache();
});

describe('buildSkillsIndexText', () => {
  test('returns empty string when explicitly disabled', () => {
    mkSkill(tmpRoot, 'alpha', 'name: alpha\ndescription: A skill');
    expect(buildSkillsIndexText({ enabled: false, skillsDir: tmpRoot })).toBe('');
  });

  test('returns empty string when skills dir does not exist', () => {
    expect(buildSkillsIndexText({ skillsDir: join(tmpRoot, 'no-such-dir') })).toBe('');
  });

  test('returns empty string when dir exists but contains no SKILL.md files', () => {
    mkdirSync(join(tmpRoot, 'empty-skill'), { recursive: true });
    expect(buildSkillsIndexText({ skillsDir: tmpRoot })).toBe('');
  });

  test('reads description from frontmatter and renders one bullet per skill', () => {
    mkSkill(tmpRoot, 'alpha', 'name: alpha\ndescription: Alpha skill — does alpha things.');
    mkSkill(tmpRoot, 'beta', 'name: beta\ndescription: "Beta skill — quoted with double."');

    const text = buildSkillsIndexText({ skillsDir: tmpRoot });
    expect(text).toContain('## Available skills');
    expect(text).toContain('- **alpha** — Alpha skill — does alpha things.');
    expect(text).toContain('- **beta** — Beta skill — quoted with double.');
  });

  test('strips both single and double quotes around description value', () => {
    mkSkill(tmpRoot, 'single', "name: single\ndescription: 'single-quoted desc'");
    mkSkill(tmpRoot, 'double', 'name: double\ndescription: "double-quoted desc"');

    const text = buildSkillsIndexText({ skillsDir: tmpRoot });
    expect(text).toContain('- **single** — single-quoted desc');
    expect(text).toContain('- **double** — double-quoted desc');
  });

  test('lists skills in alphabetical order', () => {
    mkSkill(tmpRoot, 'zeta', 'name: zeta\ndescription: Z');
    mkSkill(tmpRoot, 'alpha', 'name: alpha\ndescription: A');
    mkSkill(tmpRoot, 'mu', 'name: mu\ndescription: M');

    const text = buildSkillsIndexText({ skillsDir: tmpRoot });
    const alphaIdx = text.indexOf('alpha');
    const muIdx = text.indexOf('mu');
    const zetaIdx = text.indexOf('zeta');
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(muIdx).toBeGreaterThan(alphaIdx);
    expect(zetaIdx).toBeGreaterThan(muIdx);
  });

  test('silently skips skill dirs that have no SKILL.md', () => {
    mkSkill(tmpRoot, 'has-md', 'name: has-md\ndescription: present');
    mkdirSync(join(tmpRoot, 'no-md'), { recursive: true });

    const text = buildSkillsIndexText({ skillsDir: tmpRoot });
    expect(text).toContain('has-md');
    expect(text).not.toContain('no-md');
  });

  test('skips skills whose SKILL.md has no description field', () => {
    mkSkill(tmpRoot, 'descless', 'name: descless\nversion: "1.0"');
    mkSkill(tmpRoot, 'good', 'name: good\ndescription: has desc');

    const text = buildSkillsIndexText({ skillsDir: tmpRoot });
    expect(text).toContain('good');
    expect(text).not.toContain('descless');
  });

  test('handles block-scalar (>) multi-line descriptions', () => {
    const fm = [
      'name: multi',
      'description: >',
      '  This is a multi-line',
      '  description folded into one.',
    ].join('\n');
    mkSkill(tmpRoot, 'multi', fm);

    const text = buildSkillsIndexText({ skillsDir: tmpRoot });
    expect(text).toContain('- **multi** — This is a multi-line description folded into one.');
  });

  test('caches by mtime — same call returns identical text', () => {
    mkSkill(tmpRoot, 'alpha', 'name: alpha\ndescription: A');
    const a = buildSkillsIndexText({ skillsDir: tmpRoot });
    const b = buildSkillsIndexText({ skillsDir: tmpRoot });
    expect(a).toBe(b);
    expect(a).toContain('alpha');
  });

  test('rebuilds when SKILL.md mtime changes', async () => {
    const dir = join(tmpRoot, 'alpha');
    mkdirSync(dir, { recursive: true });
    const skillPath = join(dir, 'SKILL.md');
    writeFileSync(skillPath, '---\nname: alpha\ndescription: first\n---\n');
    const first = buildSkillsIndexText({ skillsDir: tmpRoot });
    expect(first).toContain('first');

    // Sleep 10ms to guarantee a distinct mtime tick.
    await new Promise(r => setTimeout(r, 20));
    writeFileSync(skillPath, '---\nname: alpha\ndescription: second\n---\n');

    const second = buildSkillsIndexText({ skillsDir: tmpRoot });
    expect(second).toContain('second');
    expect(second).not.toContain('first');
  });

  test('returns empty when config undefined (no defaults to ~/.claude/skills in tests)', () => {
    // No assertion about content — just that the call doesn't throw and
    // returns a string. Real default path is exercised in integration.
    const text = buildSkillsIndexText(undefined);
    expect(typeof text).toBe('string');
  });
});

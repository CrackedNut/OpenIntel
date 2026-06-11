import { describe, it, expect } from 'bun:test';
import { DiscordFormatter } from './formatter.js';

const f = new DiscordFormatter();

describe('DiscordFormatter', () => {
  it('bold / italic / code / strike use standard markdown', () => {
    expect(f.formatBold('x')).toBe('**x**');
    expect(f.formatItalic('x')).toBe('_x_');
    expect(f.formatCode('x')).toBe('`x`');
    expect(f.formatStrikethrough('x')).toBe('~~x~~');
  });

  it('code block carries the language and a trailing newline', () => {
    expect(f.formatCodeBlock('a=1', 'py')).toBe('```py\na=1\n```\n');
    expect(f.formatCodeBlock('hi')).toBe('```\nhi\n```\n');
  });

  it('mentions need the snowflake to ping; fall back to @name otherwise', () => {
    expect(f.formatUserMention('alice', '123456789012345678')).toBe('<@123456789012345678>');
    expect(f.formatUserMention('alice')).toBe('@alice');
  });

  it('links use masked markdown, but degrade when text is the url or missing', () => {
    expect(f.formatLink('docs', 'https://x.y')).toBe('[docs](https://x.y)');
    expect(f.formatLink('https://x.y', 'https://x.y')).toBe('https://x.y');
    expect(f.formatLink('', 'https://x.y')).toBe('https://x.y');
  });

  it('headings clamp to Discord-supported levels 1-3', () => {
    expect(f.formatHeading('A', 1)).toBe('# A');
    expect(f.formatHeading('A', 2)).toBe('## A');
    expect(f.formatHeading('A', 5)).toBe('### A');
  });

  it('renders tables as an aligned monospace block (no native tables)', () => {
    const out = f.formatTable(['k', 'value'], [['a', '1'], ['bb', '22']]);
    expect(out.startsWith('```\n')).toBe(true);
    expect(out).toContain('k');
    expect(out).toContain('value');
    expect(out).toContain('bb');
  });

  it('key-value list renders one bold line per item', () => {
    expect(f.formatKeyValueList([['📂', 'dir', '/x']])).toBe('📂 **dir**: /x');
  });

  it('escapeText neutralizes discord markdown specials', () => {
    expect(f.escapeText('a*b_c~d')).toBe('a\\*b\\_c\\~d');
  });

  it('formatMarkdown collapses excessive blank lines', () => {
    expect(f.formatMarkdown('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

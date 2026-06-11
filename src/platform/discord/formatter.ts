import type { PlatformFormatter } from '../formatter.js';

/**
 * Discord markdown formatter.
 *
 * Discord's flavor is close to standard markdown (like Mattermost): **bold**,
 * _italic_, `code`, ```fences```, ~~strike~~, `> quote`, and — since 2024 —
 * `#`/`##`/`###` headings and `[text](url)` masked links in normal messages.
 * The two real differences from Mattermost:
 *   - user mentions are `<@userId>` (numeric snowflake), not `@username`
 *   - there are no markdown tables, so tabular data is rendered as an aligned
 *     monospace code block (mirrors how the Slack formatter degrades tables)
 */
export class DiscordFormatter implements PlatformFormatter {
  formatBold(text: string): string {
    return `**${text}**`;
  }

  formatItalic(text: string): string {
    return `_${text}_`;
  }

  formatCode(text: string): string {
    return `\`${text}\``;
  }

  formatCodeBlock(code: string, language?: string): string {
    const lang = language || '';
    return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
  }

  formatUserMention(username: string, userId?: string): string {
    // A real ping needs the snowflake; fall back to a plain @name when we
    // only have the username (Discord won't resolve @name, but it reads fine).
    return userId ? `<@${userId}>` : `@${username}`;
  }

  formatLink(text: string, url: string): string {
    if (!text || text === url) return url;
    return `[${text}](${url})`;
  }

  formatListItem(text: string): string {
    return `- ${text}`;
  }

  formatNumberedListItem(number: number, text: string): string {
    return `${number}. ${text}`;
  }

  formatBlockquote(text: string): string {
    return `> ${text}`;
  }

  formatHorizontalRule(): string {
    // Discord has no horizontal rule; a run of box-drawing chars reads as one.
    return '────────────';
  }

  formatHeading(text: string, level: number): string {
    // Discord supports # / ## / ### only.
    const hashes = '#'.repeat(Math.min(Math.max(level, 1), 3));
    return `${hashes} ${text}`;
  }

  formatStrikethrough(text: string): string {
    return `~~${text}~~`;
  }

  escapeText(text: string): string {
    return text.replace(/([*_`~[\]()#+\-.!>|])/g, '\\$1');
  }

  formatTable(headers: string[], rows: string[][]): string {
    // No native tables — render an aligned monospace block so columns line up.
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
    );
    const pad = (cells: string[]) =>
      cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd();
    const sep = widths.map((w) => '─'.repeat(w)).join('  ');
    const lines = [pad(headers), sep, ...rows.map(pad)];
    return `\`\`\`\n${lines.join('\n')}\n\`\`\`\n`;
  }

  formatKeyValueList(items: [string, string, string][]): string {
    return items
      .map(([icon, label, value]) => `${icon} ${this.formatBold(label)}: ${value}`)
      .join('\n');
  }

  formatMarkdown(content: string): string {
    // Discord renders standard markdown; just tidy code-block boundaries and
    // collapse excessive blank lines (same treatment as Mattermost).
    let processed = content.replace(/(?<=\n)```(?=\S)(?![a-zA-Z]*\n)/g, '```\n');
    processed = processed.replace(/\n{3,}/g, '\n\n');
    return processed;
  }
}

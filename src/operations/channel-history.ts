/**
 * Channel History Context
 *
 * Builds a compact transcript of the recent channel-root conversation for
 * seeding a new thread-mode session (`!thread <topic> -history`). Sibling of
 * `context-prompt/handler.ts`'s `formatContextForClaude`, but channel-scoped
 * and kept dependency-free so both the command executor and the message
 * handler can import it without cycles.
 */

import type { PlatformClient } from '../platform/index.js';

/** How many channel-root posts to consider. */
const HISTORY_LIMIT = 30;
/** Per-message truncation, matching formatContextForClaude's cap. */
const MAX_MESSAGE_CHARS = 500;
/** Total transcript budget so a chatty channel can't blow up the prompt. */
const MAX_TOTAL_CHARS = 8000;

/**
 * Fetch and format recent channel conversation as a context block to
 * prepend to a session's initial prompt. Returns undefined when there is
 * no usable history (empty channel, platform error, …) — callers should
 * then start the session without context rather than failing.
 *
 * The block ends with a `---` separator and a trailing newline so callers
 * can do `prompt = context + prompt`.
 */
export async function buildChannelHistoryContext(
  client: PlatformClient,
  excludePostId?: string,
): Promise<string | undefined> {
  let messages;
  try {
    messages = await client.getChannelHistory({ limit: HISTORY_LIMIT });
  } catch {
    return undefined;
  }

  const relevant = messages.filter(
    (m) => m.id !== excludePostId && m.message.trim().length > 0,
  );
  if (relevant.length === 0) return undefined;

  // Walk newest→oldest so the char budget keeps the most recent messages,
  // then restore chronological order for the transcript.
  const body: string[] = [];
  let total = 0;
  for (const msg of [...relevant].reverse()) {
    const content =
      msg.message.length > MAX_MESSAGE_CHARS
        ? msg.message.substring(0, MAX_MESSAGE_CHARS) + '...'
        : msg.message;
    const line = `@${msg.username}: ${content}`;
    if (total + line.length > MAX_TOTAL_CHARS) break;
    total += line.length;
    body.push(line);
  }
  body.reverse();

  return [
    '[Recent conversation from the channel, included as context for this new thread:]',
    '',
    ...body,
    '',
    '---',
    '',
  ].join('\n');
}

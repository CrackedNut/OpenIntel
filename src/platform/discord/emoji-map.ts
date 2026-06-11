/**
 * Discord reaction emoji translation.
 *
 * OpenIntel's executors speak in emoji *shortcodes* (`eyes`,
 * `white_check_mark`, `thumbsup`, `x`, …) — see `src/utils/emoji.ts`. Discord's
 * reaction API speaks in raw unicode. These maps bridge the two: shortcode →
 * unicode when we add a reaction, unicode → shortcode when we receive one (so
 * the existing executors match it). Anything not in the map passes through
 * unchanged (covers raw unicode already supplied and custom guild emoji).
 */

const SHORTCODE_TO_UNICODE: Record<string, string> = {
  eyes: '👀',
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  thumbsup: '👍',
  '+1': '👍',
  thumbsdown: '👎',
  '-1': '👎',
  x: '❌',
  octagonal_sign: '🛑',
  stop_sign: '🛑',
  double_vertical_bar: '⏸️',
  pause_button: '⏸️',
  arrows_counterclockwise: '🔄',
  arrow_forward: '▶️',
  repeat: '🔁',
  arrow_down_small: '🔽',
  small_red_triangle_down: '🔽',
  bug: '🐛',
  one: '1️⃣',
  two: '2️⃣',
  three: '3️⃣',
  four: '4️⃣',
  five: '5️⃣',
};

// Reverse map. Where several shortcodes share a glyph, the first wins — it's
// the canonical name the executors' allow-lists check against.
const UNICODE_TO_SHORTCODE: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [code, glyph] of Object.entries(SHORTCODE_TO_UNICODE)) {
    if (!(glyph in out)) out[glyph] = code;
  }
  return out;
})();

/** Shortcode (or raw unicode) → the glyph to pass to Discord's reaction API. */
export function toDiscordEmoji(shortcodeOrUnicode: string): string {
  return SHORTCODE_TO_UNICODE[shortcodeOrUnicode] ?? shortcodeOrUnicode;
}

/** Discord reaction glyph → the shortcode OpenIntel's executors expect. */
export function fromDiscordEmoji(glyph: string): string {
  // Strip a trailing variation selector (e.g. ✔️ vs ✔) before lookup.
  return (
    UNICODE_TO_SHORTCODE[glyph] ??
    UNICODE_TO_SHORTCODE[glyph.replace(/️$/, '')] ??
    glyph
  );
}

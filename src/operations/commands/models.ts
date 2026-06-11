/**
 * The `!model` picker's choices.
 *
 * Index order == the number a user reacts with (1️⃣ = index 0). The `value`
 * is passed verbatim to `claude --model` — Claude Code aliases (`opus`,
 * `sonnet`, `haiku`) always resolve, so they're the safe core; a full model
 * id works too. `value: null` means "clear the override / inherit the
 * configured default" — never a real model.
 *
 * Edit this list to change what `!model` offers. Keep it ≤ 5 (we only post
 * 1️⃣–5️⃣).
 */
export interface ModelChoice {
  label: string;
  /** Passed to `claude --model`; null = inherit / clear override. */
  value: string | null;
}

// NOTE on the `[1m]` suffixes: that's Claude Code's 1-million-token context
// tier. `!model` resumes the existing conversation, so the target model must
// be able to hold the session's CURRENT context — for a large session (e.g.
// 500k+ tokens) a standard-window model can't load it and Claude Code silently
// keeps a 1M-capable model, so the switch appears to "not take". Opus and Fable
// have a working [1m] tier on Pro/Max — use it so the switch holds on big
// sessions. Sonnet/Haiku [1m] aren't available on this subscription (they error
// "usage credits required" / "beta not available"), so they stay standard —
// which also means you can't switch a >~200k-token session TO them (a context
// reality, not a bug).
export const MODEL_CHOICES: ModelChoice[] = [
  { label: 'Opus 4.8', value: 'claude-opus-4-8[1m]' },
  { label: 'Sonnet 4.6', value: 'sonnet' },
  { label: 'Haiku 4.5', value: 'haiku' },
  { label: 'Fable 5', value: 'claude-fable-5[1m]' },
  { label: 'Default (inherit)', value: null },
];

/** A short human label for a model value (for confirmation messages). */
export function modelLabel(value: string | null | undefined): string {
  if (!value) return 'Default (inherit)';
  return MODEL_CHOICES.find((m) => m.value === value)?.label ?? value;
}

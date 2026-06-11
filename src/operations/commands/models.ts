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

export const MODEL_CHOICES: ModelChoice[] = [
  { label: 'Opus 4.8', value: 'opus' },
  { label: 'Sonnet 4.6', value: 'sonnet' },
  { label: 'Haiku 4.5', value: 'haiku' },
  { label: 'Fable 5', value: 'claude-fable-5' },
  { label: 'Default (inherit)', value: null },
];

/** A short human label for a model value (for confirmation messages). */
export function modelLabel(value: string | null | undefined): string {
  if (!value) return 'Default (inherit)';
  return MODEL_CHOICES.find((m) => m.value === value)?.label ?? value;
}

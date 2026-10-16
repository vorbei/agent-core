// OpenRouter routes an open-weight model to many providers, several of them serving low-bit
// weights (fp8, fp4): on 2026-10-15 DeepSeek V4.1 Flash served at fp8 misread a character that
// the full-precision endpoint read right. Every OpenRouter request therefore names the precisions
// it accepts (provider.quantizations, https://openrouter.ai/docs/guides/routing/provider-selection).
// "unknown" stays allowed: the model makers' own endpoints (DeepSeek, OpenAI, Google) and Together
// declare no precision, and refusing them would refuse the closed models outright.
export const FULL_PRECISION_QUANTIZATIONS = Object.freeze(["bf16", "fp16", "fp32", "unknown"]);

/** OpenRouter provider preferences `provider` (order, sort, ignore, ...) restricted to full-precision endpoints. */
export function fullPrecisionProvider(provider = null) {
  return { ...(provider || {}), quantizations: [...FULL_PRECISION_QUANTIZATIONS] };
}

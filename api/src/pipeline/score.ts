import type { Confidence } from "@resolveai/shared";

const WEIGHT: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

/**
 * Deterministic ranking score. It orders hypotheses only; it is not a probability and is never
 * shown as a percentage. Supporting citations are capped so a long list can't dominate.
 */
export function scoreHypothesis(confidence: Confidence, supporting: number, counter: number): number {
  return WEIGHT[confidence] * 2 + Math.min(supporting, 5) - counter;
}

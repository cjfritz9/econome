import { describe, expect, it } from 'vitest';
import { costOf } from '../../src/llm/prices.ts';

const usage = (input: number, output: number, cacheWrite: number | null = null, cacheRead: number | null = null) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
});

describe('costOf', () => {
  it('prices Haiku input and output', () => {
    expect(costOf('claude-haiku-5-5', usage(1_000, 2_000))).toBeCloseTo(0.0001 + 0.001, 10);
  });

  it('prices cache writes and reads at their own rates', () => {
    expect(costOf('claude-haiku-5-5', usage(0, 0, 40_000, 40_000))).toBeCloseTo(
      (40_000 * 0.125 + 40_000 * 0.01) / 1_000_000,
      10,
    );
  });

  it('uses the long-prompt rate when a Haiku prompt passes 100,000 tokens, cached tokens included', () => {
    expect(costOf('claude-haiku-5-5', usage(1_000, 1_000, null, 100_000))).toBeCloseTo(
      (1_000 * 0.5 + 100_000 * 0.05 + 1_000 * 2.5) / 1_000_000,
      10,
    );
  });

  it('prices Sonnet input and output', () => {
    expect(costOf('claude-sonnet-5-5', usage(1_000_000, 100_000))).toBeCloseTo(2 + 1, 10);
  });
});

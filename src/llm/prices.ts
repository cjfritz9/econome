import type Anthropic from '@anthropic-ai/sdk';

export type ClaudeModel = 'claude-haiku-5-5' | 'claude-sonnet-5-5';

export type TokenUsage = Pick<
  Anthropic.Usage,
  'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'
>;

interface Rates {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

const LONG_PROMPT_TOKENS = 100_000;

// USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing on 2026-11-07.
// Cache writes are the 5-minute rate, the only TTL Économe uses.
const RATES: Record<ClaudeModel, { standard: Rates; longPrompt?: Rates }> = {
  'claude-haiku-5-5': {
    standard: { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
    longPrompt: { input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 },
  },
  'claude-sonnet-5-5': {
    standard: { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  },
};

export const costOf = (model: ClaudeModel, usage: TokenUsage): number => {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const promptTokens = usage.input_tokens + cacheWrite + cacheRead;
  const { standard, longPrompt } = RATES[model];
  const rates = longPrompt && promptTokens > LONG_PROMPT_TOKENS ? longPrompt : standard;

  const microDollars =
    usage.input_tokens * rates.input +
    cacheWrite * rates.cacheWrite +
    cacheRead * rates.cacheRead +
    usage.output_tokens * rates.output;
  return microDollars / 1_000_000;
};

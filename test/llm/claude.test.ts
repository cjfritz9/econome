import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import type { Household } from '../../src/data/household.ts';
import { createClaude, spendCapMessage, type ClaudeReply, type SpendLedger } from '../../src/llm/claude.ts';

const household: Household = {
  id: 'h1',
  name: 'Home',
  members: ['uid1'],
  settings: { timezone: 'America/New_York', dailyClaudeCapUsd: 0.5 },
};

const request = {
  model: 'claude-haiku-5-5' as const,
  system: 'Parse ingredients.',
  prompt: '2 cups spinach',
  schema: z.object({ name: z.string() }),
  maxTokens: 500,
  effort: 'low' as const,
};

const reply = (overrides: Partial<ClaudeReply> = {}): ClaudeReply => ({
  usage: { input_tokens: 1_000, output_tokens: 2_000, cache_creation_input_tokens: null, cache_read_input_tokens: null },
  stopReason: 'end_turn',
  text: '{"name":"spinach"}',
  ...overrides,
});

const memoryLedger = (spent = 0) => {
  const totals = new Map<string, number>([['h1/2026-11-07', spent]]);
  const ledger: SpendLedger = {
    spentOn: async (householdId, day) => totals.get(`${householdId}/${day}`) ?? 0,
    record: async (householdId, day, _model, usd) => {
      totals.set(`${householdId}/${day}`, (totals.get(`${householdId}/${day}`) ?? 0) + usd);
    },
  };
  return { ledger, totals };
};

const saturdayEveningInNewYork = () => new Date('2026-11-08T03:00:00Z');

describe('createClaude', () => {
  it("returns Claude's parsed answer and counts the call on the household's day", async () => {
    const { ledger, totals } = memoryLedger();
    const claude = createClaude({ send: async () => reply(), ledger, now: saturdayEveningInNewYork });

    await expect(claude.ask(household, request)).resolves.toEqual({ name: 'spinach' });
    expect(totals.get('h1/2026-11-07')).toBeCloseTo(0.0011, 10);
  });

  it('stops before calling Claude once the daily cap is spent', async () => {
    const { ledger } = memoryLedger(0.5);
    const send = vi.fn(async () => reply());
    const claude = createClaude({ send, ledger, now: saturdayEveningInNewYork });

    await expect(claude.ask(household, request)).rejects.toThrow(spendCapMessage(0.5, 0.5));
    expect(send).not.toHaveBeenCalled();
  });

  it('uses the default cap of $1 when the household has none set', async () => {
    const { ledger } = memoryLedger(0.75);
    const claude = createClaude({ send: async () => reply(), ledger, now: saturdayEveningInNewYork });

    await expect(claude.ask({ ...household, settings: { timezone: 'America/New_York' } }, request)).resolves.toBeDefined();
  });

  it.each([
    ['refusal', /declined/],
    ['max_tokens', /cut off at 500 tokens/],
  ])('reports a %s stop, and still counts what it cost', async (stopReason, message) => {
    const { ledger, totals } = memoryLedger();
    const claude = createClaude({ send: async () => reply({ stopReason }), ledger, now: saturdayEveningInNewYork });

    await expect(claude.ask(household, request)).rejects.toThrow(message);
    expect(totals.get('h1/2026-11-07')).toBeGreaterThan(0);
  });

  it("reports an answer that doesn't match the schema", async () => {
    const { ledger } = memoryLedger();
    const claude = createClaude({ send: async () => reply({ text: '{"title":1}' }), ledger, now: saturdayEveningInNewYork });

    await expect(claude.ask(household, request)).rejects.toThrow(/didn't match the expected format/);
  });
});

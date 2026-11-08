import type * as z from 'zod';
import { householdToday } from '../core/calendar.ts';
import type { Household } from '../data/household.ts';
import { withDefaults } from '../data/settings.ts';
import { logger } from '../logger.ts';
import { costOf, type ClaudeModel, type TokenUsage } from './prices.ts';

export interface ClaudeRequest<S extends z.ZodType = z.ZodType> {
  model: ClaudeModel;
  system: string;
  prompt: string;
  schema: S;
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
}

export interface ClaudeReply {
  usage: TokenUsage;
  stopReason: string | null;
  text: string;
}

export type SendToClaude = (request: ClaudeRequest) => Promise<ClaudeReply>;

export interface SpendLedger {
  spentOn: (householdId: string, day: string) => Promise<number>;
  record: (householdId: string, day: string, model: ClaudeModel, usd: number, usage: TokenUsage) => Promise<void>;
}

export interface Claude {
  ask: <S extends z.ZodType>(household: Household, request: ClaudeRequest<S>) => Promise<z.output<S>>;
}

export const spendCapMessage = (spent: number, cap: number) =>
  `Économe has spent $${spent.toFixed(2)} of its $${cap.toFixed(2)} daily Claude budget, so it stopped before calling Claude. Raise dailyClaudeCapUsd with update_settings, or try again tomorrow.`;

export class SpendCapError extends Error {}

const readOutput = <S extends z.ZodType>(schema: S, text: string): z.output<S> => {
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw new Error("Claude's answer didn't match the expected format.");
  }
};

export const createClaude = ({
  send,
  ledger,
  now = () => new Date(),
}: {
  send: SendToClaude;
  ledger: SpendLedger;
  now?: () => Date;
}): Claude => ({
  ask: async (household, request) => {
    const settings = withDefaults(household.settings);
    const day = householdToday(settings.timezone, now());
    const spent = await ledger.spentOn(household.id, day);
    if (spent >= settings.dailyClaudeCapUsd) {
      throw new SpendCapError(spendCapMessage(spent, settings.dailyClaudeCapUsd));
    }

    const reply = await send(request);
    const usd = costOf(request.model, reply.usage);
    await ledger.record(household.id, day, request.model, usd, reply.usage);
    logger.info({ model: request.model, usd, spentToday: spent + usd, usage: reply.usage }, 'Claude call');

    if (reply.stopReason === 'refusal') throw new Error('Claude declined this request.');
    if (reply.stopReason === 'max_tokens') {
      throw new Error(`Claude's answer was cut off at ${request.maxTokens} tokens.`);
    }
    return readOutput(request.schema, reply.text);
  },
});

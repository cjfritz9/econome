import * as z from 'zod';
import { MealSlot } from './weeks.ts';

export const BoxPickSchema = z.object({
  id: z.string(),
  times: z.number().int().min(1),
  servings: z.number(),
  credits: z.number(),
  why: z.array(z.string()),
  swap: z.object({ remove: z.array(z.string()), carbsAfter: z.number() }).optional(),
});

export const MealPickSchema = z.object({
  recipeId: z.string(),
  slot: MealSlot,
  servings: z.number(),
  why: z.array(z.string()),
});

const listOf = <T extends z.ZodType>(pick: T) =>
  z.object({ madeAt: z.string(), picks: z.array(pick), seen: z.array(z.string()).default([]) });

export const StoredSuggestionsSchema = z.object({
  box: listOf(BoxPickSchema).optional(),
  meals: listOf(MealPickSchema).optional(),
});

export type BoxPick = z.infer<typeof BoxPickSchema>;
export type MealPick = z.infer<typeof MealPickSchema>;
export type StoredSuggestions = z.infer<typeof StoredSuggestionsSchema>;
export type SuggestionKind = keyof StoredSuggestions;

export const storedSuggestions = (data: unknown): StoredSuggestions => {
  const parsed = StoredSuggestionsSchema.safeParse(data ?? {});
  return parsed.success ? parsed.data : {};
};

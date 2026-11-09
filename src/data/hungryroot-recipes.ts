import * as z from 'zod';
import type { HungryrootRecipeRecord } from '../core/hungryroot-box.ts';

const Nutrient = z.number().nullable();

export const HungryrootRecipeSchema = z.object({
  name: z.string(),
  hungryrootId: z.number(),
  link: z.string(),
  servings: z.number(),
  minutes: z.number().nullable(),
  nutrition: z
    .object({ kcal: Nutrient, protein: Nutrient, carbs: Nutrient, fat: Nutrient, fiber: Nutrient, sugar: Nutrient })
    .nullable(),
  products: z.array(z.object({ name: z.string(), brand: z.string().nullable(), amount: z.number(), credits: z.number() })),
  steps: z.array(z.string()),
  received: z.array(z.object({ week: z.string(), removed: z.array(z.string()), added: z.array(z.string()) })),
});

export interface HungryrootRecipes {
  find: (householdId: string, ids: string[]) => Promise<HungryrootRecipeRecord[]>;
  save: (householdId: string, records: HungryrootRecipeRecord[]) => Promise<void>;
}

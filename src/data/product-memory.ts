import * as z from 'zod';
import type { ConcernTally } from '../core/vegan.ts';

export const ROLES = ['preferred', 'alternate', 'rejected'] as const;
export type Role = (typeof ROLES)[number];

export const RememberedProductSchema = z.object({
  store: z.enum(['kroger']),
  upc: z.string(),
  ingredient: z.string().nullable(),
  role: z.enum(ROLES).nullable(),
  reason: z.string().nullable(),
  covers: z.number().positive().nullable().default(null),
  decidedBy: z.string(),
  vegan: z.object({ vegan: z.boolean(), concerns: z.array(z.string()), ingredientsHash: z.string(), by: z.string() }).nullable(),
});

export type RememberedProduct = z.infer<typeof RememberedProductSchema> & { id: string };

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const rememberedId = (store: RememberedProduct['store'], upc: string, ingredient: string | null = null) =>
  ingredient ? `${store}_${upc}_${slug(ingredient)}` : `${store}_${upc}`;

export const blankMemory = (upc: string, decidedBy: string, ingredient: string | null = null): RememberedProduct => ({
  id: rememberedId('kroger', upc, ingredient),
  store: 'kroger',
  upc,
  ingredient,
  role: null,
  reason: null,
  covers: null,
  decidedBy,
  vegan: null,
});

export const reviewOf = (memory: RememberedProduct[], upc: string) =>
  memory.find((product) => product.upc === upc && product.ingredient === null && product.vegan)?.vegan ?? undefined;

export const forIngredient = (memory: RememberedProduct[], ingredient: string, role: Role) =>
  memory.filter((product) => product.ingredient === ingredient && product.role === role);

export interface ProductMemory {
  list: (householdId: string) => Promise<RememberedProduct[]>;
  save: (householdId: string, products: RememberedProduct[]) => Promise<void>;
}

export interface VeganLine {
  tallies: (householdId: string) => Promise<Map<string, ConcernTally>>;
  count: (householdId: string, concerns: string[], ok: boolean) => Promise<void>;
}

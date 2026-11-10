import * as z from 'zod';
import type { ConcernTally } from '../core/vegan.ts';

export const STORES = ['instacart'] as const;
export type Store = (typeof STORES)[number];

export const ROLES = ['preferred', 'alternate', 'rejected'] as const;
export type Role = (typeof ROLES)[number];

const Verdict = z.enum(['vegan', 'non-vegan', 'needs-review']);

export const RememberedProductSchema = z.object({
  store: z.enum(STORES),
  productId: z.string(),
  ingredient: z.string().nullable(),
  role: z.enum(ROLES).nullable(),
  reason: z.string().nullable(),
  covers: z.number().positive().nullable().default(null),
  name: z.string().nullable().default(null),
  size: z.string().nullable().default(null),
  retailer: z.string().nullable().default(null),
  decidedBy: z.string(),
  vegan: z.object({ vegan: z.boolean(), concerns: z.array(z.string()), ingredientsHash: z.string(), by: z.string() }).nullable(),
  check: z.object({ verdict: Verdict, reasons: z.array(z.string()), label: z.string().nullable() }).nullable().default(null),
});

export type RememberedProduct = z.infer<typeof RememberedProductSchema> & { id: string };

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const rememberedId = (store: Store, productId: string, ingredient: string | null = null) =>
  ingredient ? `${store}_${productId}_${slug(ingredient)}` : `${store}_${productId}`;

export const blankMemory = (productId: string, decidedBy: string, ingredient: string | null = null, store: Store = 'instacart'): RememberedProduct => ({
  id: rememberedId(store, productId, ingredient),
  store,
  productId,
  ingredient,
  role: null,
  reason: null,
  covers: null,
  name: null,
  size: null,
  retailer: null,
  decidedBy,
  vegan: null,
  check: null,
});

export const productRecord = (memory: RememberedProduct[], productId: string, store: Store = 'instacart') =>
  memory.find((product) => product.store === store && product.productId === productId && product.ingredient === null);

export const reviewOf = (memory: RememberedProduct[], productId: string, store: Store = 'instacart') =>
  productRecord(memory, productId, store)?.vegan ?? undefined;

export const forIngredient = (memory: RememberedProduct[], ingredient: string, role: Role, store: Store = 'instacart') =>
  memory.filter((product) => product.store === store && product.ingredient === ingredient && product.role === role);

export interface ProductMemory {
  list: (householdId: string) => Promise<RememberedProduct[]>;
  save: (householdId: string, products: RememberedProduct[]) => Promise<void>;
}

export interface VeganLine {
  tallies: (householdId: string) => Promise<Map<string, ConcernTally>>;
  count: (householdId: string, concerns: string[], ok: boolean) => Promise<void>;
}

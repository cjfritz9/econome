import * as z from 'zod';
import type { ConcernTally } from '../core/vegan.ts';

export const STORES = ['kroger', 'wholefoods'] as const;
export type Store = (typeof STORES)[number];

export const ROLES = ['preferred', 'alternate', 'rejected'] as const;
export type Role = (typeof ROLES)[number];

const withProductId = (value: unknown) =>
  value && typeof value === 'object' && 'upc' in value && !('productId' in value) ? { ...value, productId: value.upc } : value;

export const RememberedProductSchema = z.preprocess(
  withProductId,
  z.object({
    store: z.enum(STORES),
    productId: z.string(),
    ingredient: z.string().nullable(),
    role: z.enum(ROLES).nullable(),
    reason: z.string().nullable(),
    covers: z.number().positive().nullable().default(null),
    decidedBy: z.string(),
    vegan: z.object({ vegan: z.boolean(), concerns: z.array(z.string()), ingredientsHash: z.string(), by: z.string() }).nullable(),
  }),
);

export type RememberedProduct = z.infer<typeof RememberedProductSchema> & { id: string };

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const rememberedId = (store: Store, productId: string, ingredient: string | null = null) =>
  ingredient ? `${store}_${productId}_${slug(ingredient)}` : `${store}_${productId}`;

export const blankMemory = (
  productId: string,
  decidedBy: string,
  ingredient: string | null = null,
  store: Store = 'kroger',
): RememberedProduct => ({
  id: rememberedId(store, productId, ingredient),
  store,
  productId,
  ingredient,
  role: null,
  reason: null,
  covers: null,
  decidedBy,
  vegan: null,
});

export const reviewOf = (memory: RememberedProduct[], productId: string, store: Store = 'kroger') =>
  memory.find((product) => product.store === store && product.productId === productId && product.ingredient === null && product.vegan)
    ?.vegan ?? undefined;

export const forIngredient = (memory: RememberedProduct[], ingredient: string, role: Role, store: Store = 'kroger') =>
  memory.filter((product) => product.store === store && product.ingredient === ingredient && product.role === role);

export interface ProductMemory {
  list: (householdId: string) => Promise<RememberedProduct[]>;
  save: (householdId: string, products: RememberedProduct[]) => Promise<void>;
}

export interface VeganLine {
  tallies: (householdId: string) => Promise<Map<string, ConcernTally>>;
  count: (householdId: string, concerns: string[], ok: boolean) => Promise<void>;
}

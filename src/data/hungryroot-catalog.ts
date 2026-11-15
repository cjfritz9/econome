import * as z from 'zod';
import type { CatalogRecipe } from '../core/hungryroot-translate.ts';
import type { HungryrootProduct } from '../sources/hungryroot.ts';

const MaybeNumber = z.number().nullable();

export const StoredProductSchema = z.object({
  id: z.number(),
  name: z.string(),
  brand: z.string().nullable(),
  credits: z.number(),
  category: z.string().nullable(),
  servings: MaybeNumber,
  servingSize: z.string().nullable().default(null),
  perServing: z.object({ kcal: MaybeNumber, protein: MaybeNumber, carbs: MaybeNumber }).nullable(),
  ingredients: z.string().nullable().default(null),
  dietaryTags: z.array(z.string()).default([]),
});

export interface StoredCatalogEntry {
  hash: string;
  gone: boolean;
}

export interface CatalogChange {
  recipe: CatalogRecipe;
  hash: string;
  isNew: boolean;
}

export interface CatalogRun {
  read: number;
  of: number;
  complete: boolean;
  added: number;
  updated: number;
  unchanged: number;
  back: number;
  gone: number;
  products: number;
  imageHostsLeftOff: string[];
}

export interface CatalogRunRecord {
  at: Date;
  seconds: number;
  error: string | null;
  counts: CatalogRun | null;
}

const Nutrient = z.number().optional();

export const StoredCatalogRecipeSchema = z.object({
  title: z.string(),
  servings: z.number(),
  steps: z.array(z.object({ instruction: z.string() })).default([]),
  nutrition: z
    .object({ kcal: Nutrient, protein: Nutrient, carbs: Nutrient, fat: Nutrient, fiber: Nutrient, sugar: Nutrient })
    .optional(),
  hungryroot: z.object({
    id: z.number(),
    credits: z.number(),
    minutes: z.number().nullable(),
    featured: z.boolean(),
    gone: z.boolean(),
    image: z.string().nullable(),
    products: z.array(z.object({ id: z.number(), name: z.string(), brand: z.string().nullable(), amount: z.number(), credits: z.number() })),
  }),
});

export type StoredCatalogRecipe = z.infer<typeof StoredCatalogRecipeSchema> & { id: string };

export interface HungryrootCatalogStore {
  entries: () => Promise<Map<string, StoredCatalogEntry>>;
  saveRecipes: (changes: CatalogChange[]) => Promise<void>;
  markGone: (ids: string[]) => Promise<void>;
  saveProducts: (products: HungryrootProduct[]) => Promise<void>;
  recordRun: (record: CatalogRunRecord) => Promise<void>;
  recentRuns: (limit: number) => Promise<CatalogRunRecord[]>;
  findRecipes: (ids: string[]) => Promise<StoredCatalogRecipe[]>;
  allRecipes: () => Promise<StoredCatalogRecipe[]>;
  allProducts: () => Promise<HungryrootProduct[]>;
}

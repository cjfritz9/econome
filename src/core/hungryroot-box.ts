import type { HungryrootNutrition, HungryrootProduct, HungryrootProductUse, HungryrootRecipe } from '../sources/hungryroot.ts';
import { recipeLink } from '../sources/hungryroot.ts';

const STARCH_CATEGORIES = new Set(['Bread + Bakery', 'Grains + Pastas']);

export interface Swaps {
  removed: string[];
  added: string[];
}

export interface ReceivedBox extends Swaps {
  week: string;
}

export interface HungryrootRecipeRecord {
  id: string;
  name: string;
  hungryrootId: number;
  link: string;
  servings: number;
  minutes: number | null;
  nutrition: HungryrootNutrition | null;
  products: Omit<HungryrootProductUse, 'id'>[];
  steps: string[];
  received: ReceivedBox[];
}

export interface Starch {
  product: string;
  carbs: number;
  credits: number;
}

export interface BoxCandidate {
  recipe: HungryrootRecipe;
  times: number;
  credits: number;
  starch: Starch[];
  carbsWithoutStarch: number | null;
}

export const sameName = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[“”″]/g, '"')
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const round = (value: number) => Math.round(value);

const starchCarbs = (use: HungryrootProductUse, product: HungryrootProduct, recipe: HungryrootRecipe) => {
  const each = product.perServing?.carbs;
  if (each === null || each === undefined) return null;
  const wholePackages = (each * (product.servings ?? 1) * use.amount) / recipe.servings;
  const recipeCarbs = recipe.nutrition?.carbs ?? Infinity;
  return wholePackages <= recipeCarbs ? wholePackages : each;
};

export const starchIn = (recipe: HungryrootRecipe, products: Map<number, HungryrootProduct>): Starch[] =>
  recipe.products.flatMap((use) => {
    const product = products.get(use.id);
    if (!product?.category || !STARCH_CATEGORIES.has(product.category)) return [];
    const carbs = starchCarbs(use, product, recipe);
    return carbs === null ? [] : [{ product: use.name, carbs: round(carbs), credits: use.credits * use.amount }];
  });

export const boxCandidates = (
  forFour: HungryrootRecipe[],
  forTwo: HungryrootRecipe[],
  products: HungryrootProduct[],
): BoxCandidate[] => {
  const byId = new Map(products.map((product) => [product.id, product]));
  const fourByName = new Map(forFour.map((recipe) => [sameName(recipe.name), recipe]));
  const doubled = forTwo.filter((recipe) => {
    const four = fourByName.get(sameName(recipe.name));
    return !four || four.credits > recipe.credits * 2;
  });
  const candidate = (recipe: HungryrootRecipe, times: number): BoxCandidate => {
    const starch = starchIn(recipe, byId);
    const carbs = recipe.nutrition?.carbs;
    return {
      recipe,
      times,
      credits: recipe.credits * times,
      starch,
      carbsWithoutStarch:
        starch.length > 0 && carbs !== null && carbs !== undefined
          ? Math.max(0, round(carbs - starch.reduce((sum, { carbs: each }) => sum + each, 0)))
          : null,
    };
  };
  const unique = new Map<string, BoxCandidate>();
  for (const each of [...forFour.map((recipe) => candidate(recipe, 1)), ...doubled.map((recipe) => candidate(recipe, 2))]) {
    const key = sameName(each.recipe.name);
    const seen = unique.get(key);
    if (!seen || each.credits < seen.credits) unique.set(key, each);
  }
  return [...unique.values()];
};

export interface CandidateFilter {
  minProtein?: number;
  maxCarbs?: number;
  exclude?: string[];
}

const proteinPerCalorie = ({ recipe }: BoxCandidate) =>
  recipe.nutrition?.protein && recipe.nutrition.kcal ? recipe.nutrition.protein / recipe.nutrition.kcal : 0;

export const rankCandidates = (candidates: BoxCandidate[], { minProtein, maxCarbs, exclude = [] }: CandidateFilter) => {
  const skipped = new Set(exclude.map(sameName));
  return candidates
    .filter(({ recipe }) => !skipped.has(sameName(recipe.name)))
    .filter(({ recipe }) => minProtein === undefined || (recipe.nutrition?.protein ?? 0) >= minProtein)
    .filter(
      ({ recipe, carbsWithoutStarch }) =>
        maxCarbs === undefined || (carbsWithoutStarch ?? recipe.nutrition?.carbs ?? Infinity) <= maxCarbs,
    )
    .sort((a, b) => proteinPerCalorie(b) - proteinPerCalorie(a) || (b.recipe.nutrition?.fiber ?? 0) - (a.recipe.nutrition?.fiber ?? 0));
};

export const findRecipe = (
  { hungryrootId, title }: { hungryrootId?: number; title?: string },
  catalog: HungryrootRecipe[],
) => {
  if (hungryrootId !== undefined) return catalog.find(({ id }) => id === hungryrootId) ?? null;
  const named = catalog.filter(({ name }) => title !== undefined && sameName(name) === sameName(title));
  return named.find(({ servings }) => servings === 4) ?? named[0] ?? null;
};

export const recipeRecord = (
  week: string,
  recipe: HungryrootRecipe,
  swaps: Swaps,
  existing: HungryrootRecipeRecord | undefined,
): HungryrootRecipeRecord => ({
  id: String(recipe.id),
  name: recipe.name,
  hungryrootId: recipe.id,
  link: recipeLink(recipe.slug),
  servings: recipe.servings,
  minutes: recipe.minutes,
  nutrition: recipe.nutrition,
  products: recipe.products.map(({ name, brand, amount, credits }) => ({ name, brand, amount, credits })),
  steps: recipe.steps,
  received: [...(existing?.received ?? []).filter((box) => box.week !== week), { week, ...swaps }],
});

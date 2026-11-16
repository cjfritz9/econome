import { createHash } from 'node:crypto';
import type { StoredCatalogRecipe } from '../data/hungryroot-catalog.ts';
import type { HungryrootNutrition, HungryrootProduct, HungryrootProductUse, HungryrootRecipe } from '../sources/hungryroot.ts';
import { recipeLink } from '../sources/hungryroot.ts';

export interface MiseIngredient {
  amount: number;
  name: string;
}

export interface MiseStep {
  step: number;
  title: string;
  instruction: string;
  ingredients: null;
}

export type MiseNutrition = Partial<Record<keyof HungryrootNutrition | 'proteinPct' | 'carbsPct' | 'netCarbsPct' | 'fatPct', number>> & {
  basis: 'stated' | 'estimated';
};

export interface CatalogRecipe {
  id: string;
  title: string;
  titleLower: string;
  description: string;
  servings: number;
  tags: string[];
  ingredientGroups: { ingredients: MiseIngredient[] }[];
  steps: MiseStep[];
  images?: string[];
  nutrition?: MiseNutrition;
  source: { kind: 'hungryroot'; id: string; url: string };
  hungryroot: {
    id: number;
    credits: number;
    minutes: number | null;
    featured: boolean;
    gone: boolean;
    image: string | null;
    products: HungryrootProductUse[];
    nutritionWasWholeRecipe?: true;
  };
}

const TAGS: Record<string, string> = {
  Vegan: 'vegan',
  'Gluten-Free': 'gluten-free',
  'Soy-Free': 'soy-free',
  'Tofu + tempeh': 'tofu-tempeh',
  '‘Meat’ alternatives': 'meat-alternatives',
  'Beans + lentils': 'beans-lentils',
  'High protein': 'high-protein',
  'Carb conscious': 'carb-conscious',
  'High fiber': 'high-fiber',
  'Low sugar': 'low-sugar',
  'Low sodium': 'low-sodium',
  '< 500 Calories': 'under-500-calories',
  '500 - 650 Calories': '500-650-calories',
  'Anti-inflammatory': 'anti-inflammatory',
  'Dinner Recipe': 'dinner',
  'Lunch-Friendly': 'lunch',
  Breakfast: 'breakfast',
  Stove: 'stovetop',
  Oven: 'oven',
  Microwave: 'microwave',
  'No Tools': 'no-cook',
  '5 Minutes or Less': 'quick',
  '10 Minutes or Less': 'quick',
  'Quick recipes': 'quick',
  Medium: 'spicy',
  Hot: 'spicy',
};

export const miseTags = (hungryrootTags: string[]) => [
  ...new Set(['hungryroot', ...hungryrootTags.flatMap((name) => TAGS[name] ?? [])]),
];

export const productLine = ({ amount, name, brand }: HungryrootProductUse): MiseIngredient => ({
  amount,
  name: brand && !name.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${name}` : name,
});

export const IMAGE_HOSTS = ['d219o304zcx1el.cloudfront.net'];

export const servableImage = (url: string | null) => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && IMAGE_HOSTS.includes(parsed.host) ? url : null;
  } catch {
    return null;
  }
};

const WHOLE_RECIPE_MATCH = { low: 0.6, high: 1.4 };
const MORE_THAN_A_MEAL_KCAL = 1_300;

const productsKcal = (recipe: HungryrootRecipe, products: Map<number, HungryrootProduct>) => {
  let total = 0;
  for (const { id, amount } of recipe.products) {
    const product = products.get(id);
    const kcal = product?.perServing?.kcal;
    if (kcal === null || kcal === undefined || !product?.servings) return null;
    total += kcal * product.servings * amount;
  }
  return recipe.products.length > 0 ? total : null;
};

export const statesWholeRecipe = (recipe: HungryrootRecipe, products: Map<number, HungryrootProduct>) => {
  const stated = recipe.nutrition?.kcal;
  const fromProducts = productsKcal(recipe, products);
  if (!stated || stated <= MORE_THAN_A_MEAL_KCAL || fromProducts === null || recipe.servings < 2) return false;
  const ratio = fromProducts / stated;
  return ratio >= WHOLE_RECIPE_MATCH.low && ratio <= WHOLE_RECIPE_MATCH.high;
};

const perServing = (value: number, servings: number) => Math.round((value / servings) * 10) / 10;

const KCAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 } as const;

const shareOfCalories = (grams: number | null | undefined, kcalPerGram: number, kcal: number | null | undefined) =>
  grams === null || grams === undefined || !kcal ? undefined : Math.round(((grams * kcalPerGram) / kcal) * 1000) / 1000;

const miseNutrition = (nutrition: HungryrootNutrition | null, divideBy: number): MiseNutrition | undefined => {
  if (!nutrition) return undefined;
  const present: Partial<Record<keyof HungryrootNutrition, number>> = Object.fromEntries(
    Object.entries(nutrition).flatMap(([name, value]) => (value === null ? [] : [[name, divideBy > 1 ? perServing(value, divideBy) : value]])),
  );
  if (Object.keys(present).length === 0) return undefined;
  const shares = Object.fromEntries(
    (['protein', 'carbs', 'fat'] as const).flatMap((macro) => {
      const share = shareOfCalories(present[macro], KCAL_PER_GRAM[macro], present.kcal);
      return share === undefined ? [] : [[`${macro}Pct`, share]];
    }),
  );
  const netCarbs = present.carbs === undefined || present.fiber === undefined ? undefined : Math.max(0, present.carbs - present.fiber);
  const netCarbsPct = shareOfCalories(netCarbs, KCAL_PER_GRAM.carbs, present.kcal);
  return { ...present, ...shares, ...(netCarbsPct !== undefined && { netCarbsPct }), basis: 'stated' };
};

export const catalogRecipe = (recipe: HungryrootRecipe, products: Map<number, HungryrootProduct> = new Map()): CatalogRecipe => {
  const link = recipeLink(recipe.slug);
  const wholeRecipe = statesWholeRecipe(recipe, products);
  const nutrition = miseNutrition(recipe.nutrition, wholeRecipe ? recipe.servings : 1);
  const image = servableImage(recipe.image);
  return {
    id: recipe.slug,
    title: recipe.name,
    titleLower: recipe.name.trim().toLowerCase(),
    description: link,
    servings: recipe.servings,
    tags: miseTags(recipe.tags),
    ingredientGroups: [{ ingredients: recipe.products.map(productLine) }],
    steps: recipe.steps.map((instruction, index) => ({ step: index + 1, title: `Step ${index + 1}`, instruction, ingredients: null })),
    ...(image && { images: [image] }),
    ...(nutrition && { nutrition }),
    source: { kind: 'hungryroot', id: String(recipe.id), url: link },
    hungryroot: {
      id: recipe.id,
      credits: recipe.credits,
      minutes: recipe.minutes,
      featured: recipe.featured,
      gone: false,
      image: recipe.image,
      products: recipe.products,
      ...(wholeRecipe && { nutritionWasWholeRecipe: true as const }),
    },
  };
};

export const fromCatalog = ({ id, title, servings, steps, nutrition, hungryroot }: StoredCatalogRecipe): HungryrootRecipe => ({
  id: hungryroot.id,
  name: title,
  slug: id,
  servings,
  credits: hungryroot.credits,
  minutes: hungryroot.minutes,
  nutrition: nutrition
    ? {
        kcal: nutrition.kcal ?? null,
        protein: nutrition.protein ?? null,
        carbs: nutrition.carbs ?? null,
        fat: nutrition.fat ?? null,
        fiber: nutrition.fiber ?? null,
        sugar: nutrition.sugar ?? null,
      }
    : null,
  tags: [],
  products: hungryroot.products,
  steps: steps.map(({ instruction }) => instruction),
  featured: hungryroot.featured,
  image: hungryroot.image,
});

export const recipeHash = (recipe: CatalogRecipe) => createHash('sha256').update(JSON.stringify(recipe)).digest('hex').slice(0, 16);

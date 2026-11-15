import { createHash } from 'node:crypto';
import type { HungryrootNutrition, HungryrootProductUse, HungryrootRecipe } from '../sources/hungryroot.ts';
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

export type MiseNutrition = Partial<Record<keyof HungryrootNutrition, number>> & { basis: 'stated' | 'estimated' };

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

const miseNutrition = (nutrition: HungryrootNutrition | null): MiseNutrition | undefined => {
  if (!nutrition) return undefined;
  const present = Object.entries(nutrition).filter((entry): entry is [keyof HungryrootNutrition, number] => entry[1] !== null);
  return present.length > 0 ? { ...Object.fromEntries(present), basis: 'stated' } : undefined;
};

export const catalogRecipe = (recipe: HungryrootRecipe): CatalogRecipe => {
  const link = recipeLink(recipe.slug);
  const nutrition = miseNutrition(recipe.nutrition);
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
    },
  };
};

export const recipeHash = (recipe: CatalogRecipe) => createHash('sha256').update(JSON.stringify(recipe)).digest('hex').slice(0, 16);

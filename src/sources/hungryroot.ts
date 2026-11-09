import * as z from 'zod';

const API = 'https://api.hungryroot.com/api/v2';
const PAGE_SIZE = 500;
const PARALLEL_PAGES = 3;
const HIGH_PROTEIN_TAG = 25;

export interface HungryrootNutrition {
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
  sugar: number | null;
}

export interface HungryrootProductUse {
  id: number;
  name: string;
  brand: string | null;
  amount: number;
  credits: number;
}

export interface HungryrootRecipe {
  id: number;
  name: string;
  slug: string;
  servings: number;
  credits: number;
  minutes: number | null;
  nutrition: HungryrootNutrition | null;
  tags: string[];
  products: HungryrootProductUse[];
  steps: string[];
}

export interface HungryrootProduct {
  id: number;
  name: string;
  brand: string | null;
  credits: number;
  category: string | null;
  servings: number | null;
  perServing: { kcal: number | null; protein: number | null; carbs: number | null } | null;
}

export interface HungryrootCatalog {
  veganRecipes: (servings: number, options?: { highProtein?: boolean }) => Promise<HungryrootRecipe[]>;
  products: () => Promise<HungryrootProduct[]>;
}

export const recipeLink = (slug: string) => `https://www.hungryroot.com/recipes/${slug}/`;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  frac14: '¼',
  frac12: '½',
  frac34: '¾',
  deg: '°',
  eacute: 'é',
  egrave: 'è',
  ntilde: 'ñ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
};

const decode = (text: string) =>
  text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z0-9]+);/gi, (entity, name: string) => ENTITIES[name] ?? entity);

export const stepsFrom = (html: string | null | undefined) =>
  (html ?? '')
    .split(/<\/p>|<\/li>|<br\s*\/?>/i)
    .map((part) => decode(part.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

const Amount = z.coerce.number();
const MaybeAmount = z.coerce.number().nullish().transform((value) => value ?? null);

const NutritionSchema = z.object({
  calories: MaybeAmount,
  protein: MaybeAmount,
  total_carb: MaybeAmount,
  total_fat: MaybeAmount,
  fiber: MaybeAmount,
  sugars: MaybeAmount,
});

const PairingSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  servings: z.number(),
  points: Amount,
  cooking_time: z.number().nullish(),
  nutrition: NutritionSchema.nullish(),
  tags: z.array(z.number()).default([]),
  short_instruction_html: z.string().nullish(),
  ingredients: z
    .array(z.object({ id: z.number(), name: z.string(), brand_name: z.string().nullish(), amount: Amount, points: Amount }))
    .default([]),
});

const PairingPageSchema = z.object({
  count: z.number(),
  results: z.object({
    pairings: z.array(PairingSchema),
    tags: z.array(z.object({ id: z.number(), name: z.string() })).default([]),
  }),
});

const ProductPageSchema = z.object({
  count: z.number(),
  results: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      brand_name: z.string().nullish(),
      points: Amount,
      primary_category_name: z.string().nullish(),
      servings: z.number().nullish(),
      nutrition: z.object({ calories: MaybeAmount, protein: MaybeAmount, total_carb: MaybeAmount }).nullish(),
    }),
  ),
});

const toRecipe = (pairing: z.infer<typeof PairingSchema>, tagNames: Map<number, string>): HungryrootRecipe => ({
  id: pairing.id,
  name: pairing.name,
  slug: pairing.slug,
  servings: pairing.servings,
  credits: pairing.points,
  minutes: pairing.cooking_time ?? null,
  nutrition: pairing.nutrition
    ? {
        kcal: pairing.nutrition.calories,
        protein: pairing.nutrition.protein,
        carbs: pairing.nutrition.total_carb,
        fat: pairing.nutrition.total_fat,
        fiber: pairing.nutrition.fiber,
        sugar: pairing.nutrition.sugars,
      }
    : null,
  tags: pairing.tags.flatMap((id) => tagNames.get(id) ?? []),
  products: pairing.ingredients.map(({ id, name, brand_name, amount, points }) => ({
    id,
    name,
    brand: brand_name ?? null,
    amount,
    credits: points,
  })),
  steps: stepsFrom(pairing.short_instruction_html),
});

export const hungryrootCatalog = (version: string, fetchJson: typeof fetch = fetch): HungryrootCatalog => {
  const get = async (path: string, params: Record<string, string | number>): Promise<unknown> => {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    const response = await fetchJson(`${API}${path}?${query}`, {
      headers: { accept: 'application/json', 'user-agent': `Econome/${version} (household grocery planner)` },
    });
    if (!response.ok) throw new Error(`Hungryroot's public catalog answered ${response.status}.`);
    return response.json();
  };

  const allPages = async <T>(read: (offset: number) => Promise<{ count: number; items: T[] }>) => {
    const first = await read(0);
    const offsets = [];
    for (let offset = PAGE_SIZE; offset < first.count; offset += PAGE_SIZE) offsets.push(offset);
    const rest: T[] = [];
    for (let start = 0; start < offsets.length; start += PARALLEL_PAGES) {
      const pages = await Promise.all(offsets.slice(start, start + PARALLEL_PAGES).map(read));
      rest.push(...pages.flatMap(({ items }) => items));
    }
    return [...first.items, ...rest];
  };

  const recipes = new Map<string, Promise<HungryrootRecipe[]>>();
  let products: Promise<HungryrootProduct[]> | undefined;

  const loadRecipes = (servings: number, highProtein: boolean) =>
    allPages(async (offset) => {
      const page = PairingPageSchema.parse(
        await get('/public_pairings/', {
          is_vegan: 1,
          servings,
          is_featured: 1,
          sideload: 'tags',
          limit: PAGE_SIZE,
          offset,
          ...(highProtein && { nutrition_tags: HIGH_PROTEIN_TAG }),
        }),
      );
      const tagNames = new Map(page.results.tags.map(({ id, name }) => [id, name]));
      return { count: page.count, items: page.results.pairings.map((pairing) => toRecipe(pairing, tagNames)) };
    });

  const loadProducts = () =>
    allPages(async (offset) => {
      const page = ProductPageSchema.parse(await get('/public_products/', { limit: PAGE_SIZE, offset }));
      return {
        count: page.count,
        items: page.results.map(({ id, name, brand_name, points, primary_category_name, servings, nutrition }) => ({
          id,
          name,
          brand: brand_name ?? null,
          credits: points,
          category: primary_category_name ?? null,
          servings: servings ?? null,
          perServing: nutrition ? { kcal: nutrition.calories, protein: nutrition.protein, carbs: nutrition.total_carb } : null,
        })),
      };
    });

  const remembered = <T>(load: () => Promise<T>, forget: () => void) =>
    load().catch((error: unknown) => {
      forget();
      throw error;
    });

  return {
    veganRecipes: (servings, { highProtein = false } = {}) => {
      const key = `${servings}|${highProtein}`;
      const cached = recipes.get(key);
      if (cached) return cached;
      const loading = remembered(() => loadRecipes(servings, highProtein), () => recipes.delete(key));
      recipes.set(key, loading);
      return loading;
    },
    products: () => {
      products ??= remembered(loadProducts, () => {
        products = undefined;
      });
      return products;
    },
  };
};

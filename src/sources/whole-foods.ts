import { gzipSync } from 'node:zlib';
import * as z from 'zod';
import type { LabelFacts } from '../core/vegan.ts';

const SITE = 'https://www.wholefoodsmarket.com';
const WHOLE_FOODS_BRAND = 'VUZHIFdob2xlIEZvb2Rz';

export interface WholeFoodsProduct {
  asin: string;
  name: string;
  brand: string | null;
  size: string | null;
  price: number | null;
  salePrice: number | null;
  primePrice: number | null;
  link: string;
}

export interface WholeFoodsDetails {
  asin: string;
  name: string;
  brand: string | null;
  label: LabelFacts;
}

export interface WholeFoods {
  search: (term: string, storeId: number, limit: number) => Promise<WholeFoodsProduct[]>;
  details: (asins: string[], storeId: number) => Promise<WholeFoodsDetails[]>;
}

const Price = z.number().nullish().transform((value) => value ?? null);

const SearchSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        slug: z.string(),
        brand: z.string().nullish(),
        regularPrice: Price,
        salePrice: Price,
        incrementalSalePrice: Price,
      }),
    )
    .default([]),
});

const DetailsSchema = z.array(
  z.object({
    asin: z.string(),
    name: z.string(),
    brandName: z.string().nullish(),
    dietTypes: z.array(z.string()).nullish(),
    ingredients: z.union([z.string(), z.array(z.string())]).nullish(),
    category: z.object({ productType: z.string().nullish(), glProductGroupSymbol: z.string().nullish() }).nullish(),
  }),
);

const PRODUCE = /produce|fruit|vegetable/i;

export const asinFromSlug = (slug: string) => slug.split('-').at(-1)?.toUpperCase() ?? '';

export const sizeFromName = (name: string) => {
  const match = /,\s*([\d./]+\s*(?:fl oz|ounces?|oz|pounds?|lbs?|g|kg|ct|count|ml|l|qt|pt|gal|each))\.?\s*$/i.exec(name);
  return match?.[1] ?? null;
};

export const productLink = (slug: string) => `${SITE}/product/${slug}`;

export const wholeFoods = (version: string, fetchJson: typeof fetch = fetch): WholeFoods => {
  const get = async (path: string, params: Record<string, string>) => {
    const response = await fetchJson(`${SITE}${path}?${new URLSearchParams(params)}`, {
      headers: { accept: 'application/json', 'user-agent': `Econome/${version} (household grocery planner)` },
    });
    if (!response.ok) throw new Error(`Whole Foods' site answered ${response.status}.`);
    return response.json() as Promise<unknown>;
  };

  return {
    search: async (term, storeId, limit) =>
      SearchSchema.parse(await get('/api/search', { text: term, store: String(storeId), limit: String(limit), offset: '0' })).results.map(
        ({ name, slug, brand, regularPrice, salePrice, incrementalSalePrice }) => ({
          asin: asinFromSlug(slug),
          name,
          brand: brand ?? null,
          size: sizeFromName(name),
          price: regularPrice,
          salePrice: salePrice && regularPrice && salePrice < regularPrice ? salePrice : null,
          primePrice: incrementalSalePrice,
          link: productLink(slug),
        }),
      ),

    details: async (asins, storeId) => {
      if (asins.length === 0) return [];
      return DetailsSchema.parse(await get('/api/wwos/products', { asins: asins.join(','), store: String(storeId) })).map(
        ({ asin, name, brandName, dietTypes, ingredients, category }) => ({
          asin,
          name,
          brand: brandName ?? null,
          label: {
            ingredients: Array.isArray(ingredients) ? ingredients.join(', ') : (ingredients ?? null),
            categories: [category?.productType, category?.glProductGroupSymbol].some((value) => PRODUCE.test(value ?? '')) ? ['Produce'] : [],
            declarations: (dietTypes ?? []).map((diet) => (/^vegan$/i.test(diet) ? 'Vegan' : diet)),
            contains: [],
            mayContain: [],
          },
        }),
      );
    },
  };
};

export interface HandoffItem {
  name: string;
  quantity: number;
  asin?: string;
}

export interface AlexaLine {
  quantity: number;
  name: string;
  brand?: string | null;
}

const letters = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

const withBrand = (name: string, brand: string | null | undefined) => (brand && !letters(name).includes(letters(brand)) ? `${brand} ${name}` : name);

export const alexaList = (lines: AlexaLine[]) =>
  ["Add these to my Whole Foods cart. If one isn't available, ask me before choosing something else:", ...lines.map(({ quantity, name, brand }) => `${quantity} × ${withBrand(name, brand)}`)].join('\n');

export const wholeFoodsCartLink = (items: HandoffItem[]) => {
  const ingredients = items.map(({ name, quantity, asin }) => ({
    name,
    quantityList: [{ unit: 'COUNT', amount: quantity }],
    ...(asin && { asinOverride: asin }),
  }));
  const encoded = gzipSync(JSON.stringify({ ingredients })).toString('base64url');
  return `https://www.amazon.com/afx/ingredients/landingencoded?almBrandId=${WHOLE_FOODS_BRAND}&encodedIngredients=${encoded}`;
};

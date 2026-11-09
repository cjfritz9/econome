import * as z from 'zod';
import type { LabelFacts } from '../core/vegan.ts';

const API = 'https://api.kroger.com/v1';
const SITE = 'https://www.kroger.com';
const TOKEN_MARGIN_MS = 60_000;
const IDS_PER_LOOKUP = 50;

export interface KrogerStore {
  locationId: string;
  name: string;
  chain: string;
  address: string;
}

export interface KrogerProduct {
  upc: string;
  brand: string | null;
  description: string;
  size: string | null;
  price: number | null;
  salePrice: number | null;
  stock: string | null;
  aisle: string | null;
  declaredVegan: boolean;
  allergens: string[];
  link: string | null;
  label: LabelFacts;
}

export interface Kroger {
  stores: (zipCode: string) => Promise<KrogerStore[]>;
  store: (locationId: string) => Promise<KrogerStore | null>;
  search: (term: string, locationId: string, limit: number) => Promise<KrogerProduct[]>;
  lookup: (upcs: string[], locationId: string) => Promise<KrogerProduct[]>;
}

const TokenSchema = z.object({ access_token: z.string(), expires_in: z.number() });

const LocationSchema = z.object({
  locationId: z.string(),
  name: z.string(),
  chain: z.string().nullish(),
  address: z
    .object({ addressLine1: z.string().nullish(), city: z.string().nullish(), state: z.string().nullish(), zipCode: z.string().nullish() })
    .nullish(),
});

const ProductSchema = z.object({
  upc: z.string(),
  brand: z.string().nullish(),
  description: z.string(),
  productPageURI: z.string().nullish(),
  manufacturerDeclarations: z.array(z.string()).nullish(),
  categories: z.array(z.string()).nullish(),
  nutritionInformation: z.array(z.object({ ingredientStatement: z.string().nullish() })).nullish(),
  allergens: z.array(z.object({ name: z.string().nullish(), levelOfContainmentName: z.string().nullish() })).nullish(),
  aisleLocations: z.array(z.object({ description: z.string().nullish() })).nullish(),
  items: z
    .array(
      z.object({
        size: z.string().nullish(),
        price: z.object({ regular: z.number().nullish(), promo: z.number().nullish() }).nullish(),
        inventory: z.object({ stockLevel: z.string().nullish() }).nullish(),
      }),
    )
    .nullish(),
});

const toStore = ({ locationId, name, chain, address }: z.infer<typeof LocationSchema>): KrogerStore => ({
  locationId,
  name,
  chain: chain ?? '',
  address: [address?.addressLine1, address?.city, [address?.state, address?.zipCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', '),
});

const CONTAINS = /^contains$/i;
const MAY_CONTAIN = /may contain/i;

const allergensAt = (allergens: z.infer<typeof ProductSchema>['allergens'], level: RegExp) =>
  (allergens ?? []).filter(({ levelOfContainmentName }) => level.test(levelOfContainmentName ?? '')).flatMap(({ name }) => (name ? [name] : []));

export const toProduct = (json: z.infer<typeof ProductSchema>): KrogerProduct => {
  const item = json.items?.[0];
  const regular = item?.price?.regular ?? null;
  const promo = item?.price?.promo ?? null;
  return {
    upc: json.upc,
    brand: json.brand ?? null,
    description: json.description,
    size: item?.size ?? null,
    price: regular,
    salePrice: promo && regular && promo < regular ? promo : null,
    stock: item?.inventory?.stockLevel ?? null,
    aisle: json.aisleLocations?.[0]?.description ?? null,
    declaredVegan: (json.manufacturerDeclarations ?? []).some((declaration) => /^vegan$/i.test(declaration.trim())),
    allergens: allergensAt(json.allergens, CONTAINS),
    link: json.productPageURI ? `${SITE}${json.productPageURI}` : null,
    label: {
      ingredients: json.nutritionInformation?.find(({ ingredientStatement }) => ingredientStatement)?.ingredientStatement ?? null,
      categories: json.categories ?? [],
      declarations: json.manufacturerDeclarations ?? [],
      contains: allergensAt(json.allergens, CONTAINS),
      mayContain: allergensAt(json.allergens, MAY_CONTAIN),
    },
  };
};

export const krogerClient = (
  { clientId, clientSecret, version }: { clientId: string; clientSecret: string; version: string },
  fetchJson: typeof fetch = fetch,
  now = () => Date.now(),
): Kroger => {
  const userAgent = `Econome/${version} (household grocery planner)`;
  let token: { value: string; expiresAt: number } | undefined;

  const accessToken = async () => {
    if (token && token.expiresAt - TOKEN_MARGIN_MS > now()) return token.value;
    const response = await fetchJson(`${API}/connect/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': userAgent,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'product.compact' }),
    });
    if (!response.ok) throw new Error(`Kroger refused Économe's app credentials (${response.status}). Check KROGER_CLIENT_ID and KROGER_CLIENT_SECRET in app/.env.`);
    const { access_token, expires_in } = TokenSchema.parse(await response.json());
    token = { value: access_token, expiresAt: now() + expires_in * 1000 };
    return access_token;
  };

  const get = async (path: string, params: Record<string, string>) => {
    const response = await fetchJson(`${API}${path}?${new URLSearchParams(params)}`, {
      headers: { authorization: `Bearer ${await accessToken()}`, accept: 'application/json', 'user-agent': userAgent },
    });
    if (response.status === 404) return null;
    if (response.status === 429) throw new Error("Kroger's daily request limit is used up; it resets 24 hours after the first call.");
    if (!response.ok) throw new Error(`Kroger answered ${response.status}.`);
    return response.json() as Promise<unknown>;
  };

  return {
    stores: async (zipCode) => {
      const json = await get('/locations', { 'filter.zipCode.near': zipCode, 'filter.limit': '10' });
      return z.object({ data: z.array(LocationSchema) }).parse(json ?? { data: [] }).data.map(toStore);
    },

    store: async (locationId) => {
      const json = await get(`/locations/${encodeURIComponent(locationId)}`, {});
      return json ? toStore(z.object({ data: LocationSchema }).parse(json).data) : null;
    },

    search: async (term, locationId, limit) => {
      const json = await get('/products', {
        'filter.term': term,
        'filter.locationId': locationId,
        'filter.limit': String(limit),
      });
      return z.object({ data: z.array(ProductSchema) }).parse(json ?? { data: [] }).data.map(toProduct);
    },

    lookup: async (upcs, locationId) => {
      const found: KrogerProduct[] = [];
      for (let start = 0; start < upcs.length; start += IDS_PER_LOOKUP) {
        const json = await get('/products', {
          'filter.productId': upcs.slice(start, start + IDS_PER_LOOKUP).join(','),
          'filter.locationId': locationId,
          'filter.limit': String(IDS_PER_LOOKUP),
        });
        found.push(...z.object({ data: z.array(ProductSchema) }).parse(json ?? { data: [] }).data.map(toProduct));
      }
      return found;
    },
  };
};

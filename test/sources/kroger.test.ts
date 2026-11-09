import { describe, expect, it } from 'vitest';
import { krogerClient, toProduct } from '../../src/sources/kroger.ts';

const credentials = { clientId: 'id', clientSecret: 'secret', version: '1.2.3' };

const fakeKroger = (routes: Record<string, (url: URL) => { status?: number; body: unknown }>) => {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchJson = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const route = Object.entries(routes).find(([path]) => url.pathname.endsWith(path));
    const { status = 200, body } = route ? route[1](url) : { status: 404, body: {} };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchJson, calls };
};

const token = () => ({ body: { access_token: 'abc', expires_in: 1800 } });

const tofu = {
  upc: '0001111091342',
  brand: 'Simple Truth Organic',
  description: 'Simple Truth Organic® Extra Firm Tofu',
  productPageURI: '/p/tofu/0001111091342',
  manufacturerDeclarations: ['Organic', 'Vegan'],
  allergens: [
    { name: 'Soybean and its Derivatives', levelOfContainmentName: 'Contains' },
    { name: 'Cereals and Their Derivatives', levelOfContainmentName: 'Free from' },
  ],
  aisleLocations: [{ description: 'AISLE 1' }],
  items: [{ size: '14 oz', price: { regular: 2.19, promo: 1.99 }, inventory: { stockLevel: 'HIGH' } }],
};

describe('toProduct', () => {
  it("keeps Kroger's own wording and reads price, sale, stock, aisle, vegan declaration and allergens", () => {
    expect(toProduct(tofu)).toEqual({
      upc: '0001111091342',
      brand: 'Simple Truth Organic',
      description: 'Simple Truth Organic® Extra Firm Tofu',
      size: '14 oz',
      price: 2.19,
      salePrice: 1.99,
      stock: 'HIGH',
      aisle: 'AISLE 1',
      declaredVegan: true,
      allergens: ['Soybean and its Derivatives'],
      link: 'https://www.kroger.com/p/tofu/0001111091342',
      label: {
        ingredients: null,
        categories: [],
        declarations: ['Organic', 'Vegan'],
        contains: ['Soybean and its Derivatives'],
        mayContain: [],
      },
    });
  });

  it('shows no sale when the promo price is missing or not lower', () => {
    const regularOnly = { ...tofu, items: [{ price: { regular: 2.19, promo: 0 } }] };

    expect(toProduct(regularOnly)).toMatchObject({ price: 2.19, salePrice: null, stock: null, size: null });
  });
});

describe('krogerClient', () => {
  it('signs in with the app credentials once, then searches products at the store, naming Économe', async () => {
    const { fetchJson, calls } = fakeKroger({ '/token': token, '/products': () => ({ body: { data: [tofu] } }) });
    const kroger = krogerClient(credentials, fetchJson);

    await kroger.search('extra firm tofu', '01400513', 3);
    const products = await kroger.search('tempeh', '01400513', 3);

    expect(products[0]?.upc).toBe('0001111091342');
    expect(calls.filter(({ url }) => url.pathname.endsWith('/token'))).toHaveLength(1);
    const search = calls.find(({ url }) => url.pathname.endsWith('/products'));
    expect(Object.fromEntries(search?.url.searchParams ?? [])).toEqual({
      'filter.term': 'extra firm tofu',
      'filter.locationId': '01400513',
      'filter.limit': '3',
    });
    expect(search?.init?.headers).toMatchObject({ authorization: 'Bearer abc', 'user-agent': 'Econome/1.2.3 (household grocery planner)' });
  });

  it('signs in again once the token is about to expire', async () => {
    const { fetchJson, calls } = fakeKroger({ '/token': token, '/products': () => ({ body: { data: [] } }) });
    let now = 0;
    const kroger = krogerClient(credentials, fetchJson, () => now);

    await kroger.search('tofu', '01400513', 1);
    now = 1_750_000;
    await kroger.search('tofu', '01400513', 1);

    expect(calls.filter(({ url }) => url.pathname.endsWith('/token'))).toHaveLength(2);
  });

  it('lists stores near a zip code with a readable address', async () => {
    const location = {
      locationId: '01400513',
      name: 'Kroger On the Rhine',
      chain: 'KROGER',
      address: { addressLine1: '100 E Court St', city: 'Cincinnati', state: 'OH', zipCode: '45202' },
    };
    const { fetchJson, calls } = fakeKroger({ '/token': token, '/locations': () => ({ body: { data: [location] } }) });

    expect(await krogerClient(credentials, fetchJson).stores('45202')).toEqual([
      { locationId: '01400513', name: 'Kroger On the Rhine', chain: 'KROGER', address: '100 E Court St, Cincinnati, OH 45202' },
    ]);
    expect(calls.at(-1)?.url.searchParams.get('filter.zipCode.near')).toBe('45202');
  });

  it('finds no store for an id Kroger no longer has', async () => {
    const { fetchJson } = fakeKroger({ '/token': token });

    expect(await krogerClient(credentials, fetchJson).store('99999999')).toBeNull();
  });

  it('says when the app credentials are refused, and when the daily limit is used up', async () => {
    const refused = fakeKroger({ '/token': () => ({ status: 401, body: {} }) });
    await expect(krogerClient(credentials, refused.fetchJson).search('tofu', '1', 1)).rejects.toThrow(/refused Économe's app credentials \(401\)/);

    const limited = fakeKroger({ '/token': token, '/products': () => ({ status: 429, body: {} }) });
    await expect(krogerClient(credentials, limited.fetchJson).search('tofu', '1', 1)).rejects.toThrow(/daily request limit/);
  });
});

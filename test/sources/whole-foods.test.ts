import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { alexaList, asinFromSlug, sizeFromName, wholeFoods, wholeFoodsCartLink } from '../../src/sources/whole-foods.ts';

const answering = (body: unknown) => {
  const urls: URL[] = [];
  const fetchJson = (async (input: string | URL | Request) => {
    urls.push(new URL(String(input)));
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  return { fetchJson, urls };
};

describe('wholeFoods', () => {
  it("searches the household's store, reading the ASIN from the slug, the size from the name and any sale", async () => {
    const { fetchJson, urls } = answering({
      results: [
        { name: 'Organic Extra Firm Tofu, 14 OZ', slug: '365-by-whole-foods-market-organic-extra-firm-tofu-14-oz-b09qpk8bn1', brand: '365', regularPrice: 2.39, salePrice: 1.99, incrementalSalePrice: 1.79 },
      ],
    });

    const [product] = await wholeFoods('1.2.3', fetchJson).search('tofu', 10257, 3);

    expect(product).toEqual({
      asin: 'B09QPK8BN1',
      name: 'Organic Extra Firm Tofu, 14 OZ',
      brand: '365',
      size: '14 OZ',
      price: 2.39,
      salePrice: 1.99,
      primePrice: 1.79,
      link: 'https://www.wholefoodsmarket.com/product/365-by-whole-foods-market-organic-extra-firm-tofu-14-oz-b09qpk8bn1',
    });
    expect(Object.fromEntries(urls[0]?.searchParams ?? [])).toEqual({ text: 'tofu', store: '10257', limit: '3', offset: '0' });
  });

  it("reads a product's details into label facts: its vegan diet type, ingredients and produce category", async () => {
    const { fetchJson } = answering([
      { asin: 'B0D9WW1FNS', name: 'Pressed Extra Firm Tofu, 14 Ounce', brandName: '365 by Whole Foods Market', dietTypes: ['vegan'], ingredients: ['Water', 'Soybeans'], category: { productType: 'TOFU' } },
      { asin: 'B000000001', name: 'Organic Lemons', dietTypes: [], ingredients: null, category: { productType: 'PRODUCE' } },
    ]);

    const [tofu, lemons] = await wholeFoods('1', fetchJson).details(['B0D9WW1FNS', 'B000000001'], 10257);

    expect(tofu?.label).toEqual({ ingredients: 'Water, Soybeans', categories: [], declarations: ['Vegan'], contains: [], mayContain: [] });
    expect(tofu?.brand).toBe('365 by Whole Foods Market');
    expect(lemons?.label.categories).toEqual(['Produce']);
    expect(lemons?.brand).toBeNull();
  });

  it('asks for nothing when there are no products to look up', async () => {
    const { fetchJson, urls } = answering([]);

    expect(await wholeFoods('1', fetchJson).details([], 10257)).toEqual([]);
    expect(urls).toEqual([]);
  });
});

describe('asinFromSlug and sizeFromName', () => {
  it('take the ASIN from the end of the slug and the size from the end of the name', () => {
    expect(asinFromSlug('oceans-halo-organic-sushi-nori-1-oz-b077dzcf65')).toBe('B077DZCF65');
    expect(sizeFromName('Organic Sushi Nori, 1 OZ')).toBe('1 OZ');
    expect(sizeFromName('Extra Firm Tofu, Vacuum Packed, 14 Ounce')).toBe('14 Ounce');
    expect(sizeFromName('Organic Lemons')).toBeNull();
  });
});

describe('wholeFoodsCartLink', () => {
  it("builds Amazon's Whole Foods ingredient link with each product pinned by its ASIN", () => {
    const link = new URL(
      wholeFoodsCartLink([
        { name: 'nori', quantity: 1, asin: 'B077DZCF65' },
        { name: 'extra-firm tofu', quantity: 3, asin: 'B00XMZFBSG' },
        { name: 'massaman curry paste', quantity: 2 },
      ]),
    );
    const encoded = link.searchParams.get('encodedIngredients') ?? '';

    expect(link.origin + link.pathname).toBe('https://www.amazon.com/afx/ingredients/landingencoded');
    expect(link.searchParams.get('almBrandId')).toBe('VUZHIFdob2xlIEZvb2Rz');
    expect(encoded).not.toContain('=');
    expect(JSON.parse(gunzipSync(Buffer.from(encoded, 'base64url')).toString())).toEqual({
      ingredients: [
        { name: 'nori', quantityList: [{ unit: 'COUNT', amount: 1 }], asinOverride: 'B077DZCF65' },
        { name: 'extra-firm tofu', quantityList: [{ unit: 'COUNT', amount: 3 }], asinOverride: 'B00XMZFBSG' },
        { name: 'massaman curry paste', quantityList: [{ unit: 'COUNT', amount: 2 }] },
      ],
    });
  });
});

describe('alexaList', () => {
  it('asks for each product by brand and name with its quantity, adding the brand only when the name lacks it', () => {
    expect(
      alexaList([
        { quantity: 5, name: 'Mori Nu Tofu Extra Firm Tofu, 10.9 OZ', brand: 'Mori-Nu' },
        { quantity: 1, name: 'Organic Silken Tofu, 16 oz', brand: '365 by Whole Foods Market' },
        { quantity: 3, name: 'lemons' },
      ]),
    ).toBe(
      [
        "Add these to my Whole Foods cart. If one isn't available, ask me before choosing something else:",
        '5 × Mori Nu Tofu Extra Firm Tofu, 10.9 OZ',
        '1 × 365 by Whole Foods Market Organic Silken Tofu, 16 oz',
        '3 × lemons',
      ].join('\n'),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { hungryrootCatalog, recipeLink, stepsFrom } from '../../src/sources/hungryroot.ts';

const pairing = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Recipe ${id}`,
  slug: `recipe-${id}`,
  servings: 4,
  points: '14.00',
  cooking_time: 10,
  nutrition: { calories: 440, protein: '30.00', total_carb: '62.00', total_fat: '11.00', fiber: '10.00', sugars: null },
  tags: [25, 999],
  short_instruction_html: '<p>Cube the tofu.</p><p>Sauté 2&ndash;3 min.</p>',
  ingredients: [{ id: 7, name: 'Organic Extra Firm Tofu', brand_name: 'Hodo Soy', amount: 2.0, points: '3.00' }],
  ...overrides,
});

const fakeFetch = (respond: (url: URL) => unknown, status = 200) => {
  const urls: URL[] = [];
  const fetchJson = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    return new Response(JSON.stringify(respond(url)), { status });
  }) as typeof fetch;
  return { fetchJson, urls };
};

const pairingPages = (total: number) => (url: URL) => {
  const offset = Number(url.searchParams.get('offset'));
  const limit = Number(url.searchParams.get('limit'));
  const ids = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => offset + index + 1);
  return { count: total, results: { pairings: ids.map((id) => pairing(id)), tags: [{ id: 25, name: 'High protein' }] } };
};

describe('hungryrootCatalog', () => {
  it("reads every page of vegan recipes of one size with the site's own filters, naming Économe", async () => {
    const { fetchJson, urls } = fakeFetch(pairingPages(1_200));
    const recipes = await hungryrootCatalog('1.2.3', fetchJson).veganRecipes(4, { highProtein: true });

    expect(recipes).toHaveLength(1_200);
    expect(urls.map((url) => url.searchParams.get('offset'))).toEqual(['0', '500', '1000']);
    expect(Object.fromEntries(urls[0]?.searchParams ?? [])).toMatchObject({
      is_vegan: '1',
      servings: '4',
      is_featured: '1',
      sideload: 'tags',
      nutrition_tags: '25',
      limit: '500',
    });
  });

  it('turns a recipe into numbers, tag names and products', async () => {
    const { fetchJson } = fakeFetch(pairingPages(1));
    const [recipe] = await hungryrootCatalog('1', fetchJson).veganRecipes(4);

    expect(recipe).toEqual({
      id: 1,
      name: 'Recipe 1',
      slug: 'recipe-1',
      servings: 4,
      credits: 14,
      minutes: 10,
      nutrition: { kcal: 440, protein: 30, carbs: 62, fat: 11, fiber: 10, sugar: null },
      tags: ['High protein'],
      products: [{ id: 7, name: 'Organic Extra Firm Tofu', brand: 'Hodo Soy', amount: 2, credits: 3 }],
      steps: ['Cube the tofu.', 'Sauté 2–3 min.'],
    });
  });

  it('leaves out the high-protein filter unless asked', async () => {
    const { fetchJson, urls } = fakeFetch(pairingPages(1));
    await hungryrootCatalog('1', fetchJson).veganRecipes(2);

    expect(urls[0]?.searchParams.has('nutrition_tags')).toBe(false);
  });

  it('keeps what it read in memory, so asking again reads nothing', async () => {
    const { fetchJson, urls } = fakeFetch(pairingPages(3));
    const catalog = hungryrootCatalog('1', fetchJson);

    await catalog.veganRecipes(4);
    await catalog.veganRecipes(4);

    expect(urls).toHaveLength(1);
  });

  it('reads the product list', async () => {
    const { fetchJson } = fakeFetch(() => ({
      count: 1,
      results: [
        {
          id: 7,
          name: 'Shelled Edamame',
          brand_name: "Melissa's",
          points: '3.00',
          primary_category_name: 'Produce',
          servings: 3,
          nutrition: { calories: 100, protein: '11.00', total_carb: '8.00' },
        },
      ],
    }));

    expect(await hungryrootCatalog('1', fetchJson).products()).toEqual([
      {
        id: 7,
        name: 'Shelled Edamame',
        brand: "Melissa's",
        credits: 3,
        category: 'Produce',
        servings: 3,
        perServing: { kcal: 100, protein: 11, carbs: 8 },
      },
    ]);
  });

  it('says what Hungryroot answered when a read fails, and tries again next time', async () => {
    let status = 503;
    const fetchJson = (async () => new Response(JSON.stringify({ count: 0, results: [] }), { status })) as typeof fetch;
    const catalog = hungryrootCatalog('1', fetchJson);

    await expect(catalog.products()).rejects.toThrow("Hungryroot's public catalog answered 503.");
    status = 200;
    await expect(catalog.products()).resolves.toEqual([]);
  });
});

describe('recipeLink', () => {
  it("points at the recipe's public page", () => {
    expect(recipeLink('tofu-green-beans-rice-1')).toBe('https://www.hungryroot.com/recipes/tofu-green-beans-rice-1/');
  });
});

describe('stepsFrom', () => {
  it('splits paragraphs and list items into steps, decoding entities and dropping tags', () => {
    expect(stepsFrom('<p>Boil &frac34; cup water</p><ul><li>Add <b>tofu</b> &amp; stir</li><li>Serve&mdash;enjoy!</li></ul>')).toEqual([
      'Boil ¾ cup water',
      'Add tofu & stir',
      'Serve—enjoy!',
    ]);
  });

  it('has no steps without instructions', () => {
    expect(stepsFrom(null)).toEqual([]);
  });
});

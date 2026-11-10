import { describe, expect, it } from 'vitest';
import { fdcClient, searchTerm, toFood } from '../../src/sources/fdc.ts';

const nutrients = (pairs: [string, number][]) => pairs.map(([number, amount]) => ({ nutrient: { number }, amount }));

describe('toFood', () => {
  it('reads nutrients per 100 g by number, falling back to the Foundation numbers', () => {
    const food = toFood({
      fdcId: 1,
      description: 'Flour',
      dataType: 'Foundation',
      foodNutrients: nutrients([
        ['957', 364],
        ['203', 10],
        ['205.2', 76],
        ['269.3', 0.3],
        ['298', 1.2],
      ]),
      foodPortions: [],
    });

    expect(food.per100g).toEqual({ kcal: 364, protein: 10, carbs: 76, sugar: 0.3, fiber: null, fat: 1.2 });
  });

  it('describes SR Legacy, FNDDS and branded portions, and skips RACC and unspecified ones', () => {
    const food = toFood({
      fdcId: 2,
      description: 'VEGAN MAYO',
      dataType: 'Branded',
      brandOwner: 'Acme Foods',
      servingSize: 14,
      servingSizeUnit: 'GRM',
      householdServingFullText: '1 Tbsp',
      foodNutrients: [],
      foodPortions: [
        { amount: 1, modifier: 'cup', measureUnit: { name: 'undetermined' }, gramWeight: 125 },
        { modifier: '10205', portionDescription: '1 cup', measureUnit: { name: 'undetermined' }, gramWeight: 159 },
        { modifier: '90000', portionDescription: 'Quantity not specified', gramWeight: 80 },
        { amount: 1, measureUnit: { name: 'RACC' }, gramWeight: 30 },
        { amount: 0.2, modifier: 'block', measureUnit: { name: 'undetermined' }, gramWeight: 91 },
      ],
    });

    expect(food.description).toBe('VEGAN MAYO (Acme Foods)');
    expect(food.portions).toEqual(['1 cup = 125 g', '1 cup = 159 g', '0.2 block = 91 g', '1 Tbsp = 14 g']);
  });
});

describe('searchTerm', () => {
  it('drops accents, which FoodData Central spells without', () => {
    expect(searchTerm(' jalapeño ')).toBe('jalapeno');
    expect(searchTerm('crème fraîche')).toBe('creme fraiche');
  });
});

describe('fdcClient', () => {
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('searches generic and branded foods, then fetches both in one lookup, in search order without repeats', async () => {
    const requests: { url: string; body: { dataType?: string[]; fdcIds?: number[] } }[] = [];
    const fetchJson: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(input), body });
      if (String(input).includes('/foods/search')) {
        return respond({ foods: body.dataType.includes('Branded') ? [{ fdcId: 30 }, { fdcId: 10 }] : [{ fdcId: 10 }, { fdcId: 20 }] });
      }
      return respond(body.fdcIds.map((fdcId: number) => ({ fdcId, description: `food ${fdcId}`, dataType: 'SR Legacy' })));
    };

    const foods = await fdcClient('key', fetchJson).candidates('tofu');

    expect(foods.map(({ fdcId }) => fdcId)).toEqual([10, 20, 30]);
    expect(requests.find(({ url }) => url.includes('/foods?'))?.body.fdcIds).toEqual([10, 20, 30]);
    expect(requests.every(({ url }) => url.includes('api_key=key'))).toBe(true);
    expect(requests.filter(({ url }) => url.includes('/foods/search')).map(({ body }) => (body as { query?: string }).query)).toEqual(['tofu', 'tofu']);
  });

  it('searches branded foods for their brand and ingredient list, straight from the search results', async () => {
    const bodies: { query?: string; dataType?: string[] }[] = [];
    const fetchJson: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return respond({
        foods: [
          { fdcId: 1, description: 'JUST LIKE MOZZARELLA SHREDS', brandName: 'Violife', brandOwner: 'Upfield', ingredients: 'Filtered Water, Coconut Oil' },
          { fdcId: 2, description: 'EXTRA FIRM TOFU' },
        ],
      });
    };

    const foods = await fdcClient('key', fetchJson).branded('Violife Mozzarella Shreds');

    expect(bodies).toEqual([{ query: 'Violife Mozzarella Shreds', dataType: ['Branded'], pageSize: 50 }]);
    expect(foods).toEqual([
      { fdcId: 1, description: 'JUST LIKE MOZZARELLA SHREDS', brand: 'Violife', owner: 'Upfield', ingredients: 'Filtered Water, Coconut Oil' },
      { fdcId: 2, description: 'EXTRA FIRM TOFU', brand: null, owner: null, ingredients: null },
    ]);
  });

  it('says when the hourly limit is used up', async () => {
    const fetchJson: typeof fetch = async () => respond({}, 429);

    await expect(fdcClient('key', fetchJson).food(1)).rejects.toThrow(/hourly request limit/);
  });
});

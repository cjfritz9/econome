import { describe, expect, it } from 'vitest';
import { boxCandidates, findRecipe, rankCandidates, recipeRecord, sameName, starchIn } from '../../src/core/hungryroot-box.ts';
import type { HungryrootProduct, HungryrootRecipe } from '../../src/sources/hungryroot.ts';

const product = (id: number, name: string, category: string, carbs: number, servings = 1): HungryrootProduct => ({
  id,
  name,
  brand: null,
  credits: 2,
  category,
  servings,
  perServing: { kcal: 100, protein: 2, carbs },
});

const RICE = product(1, 'Brown Rice Quinoa Blend', 'Grains + Pastas', 41, 2);
const TOFU = product(2, 'Organic Extra Firm Tofu', 'Plant-Based Proteins', 4, 4);
const BUNS = product(3, 'Multigrain Buns', 'Bread + Bakery', 33, 8);
const products = [RICE, TOFU, BUNS];

const recipe = (
  id: number,
  name: string,
  servings: number,
  { credits = 14, protein = 30, kcal = 440, carbs = 62, uses = [RICE, TOFU] }: Partial<{ credits: number; protein: number; kcal: number; carbs: number; uses: HungryrootProduct[] }> = {},
): HungryrootRecipe => ({
  id,
  name,
  slug: `slug-${id}`,
  servings,
  credits,
  minutes: 10,
  nutrition: { kcal, protein, carbs, fat: 11, fiber: 10, sugar: 4 },
  tags: [],
  products: uses.map((use) => ({ id: use.id, name: use.name, brand: null, amount: servings / 2, credits: 2 })),
  steps: ['Cube the tofu.'],
});

describe('sameName', () => {
  it('ignores case, spacing, accents and curly quotes', () => {
    expect(sameName('“Chicken”  Parm Jalapeño')).toBe(sameName('"chicken" parm jalapeno'));
  });
});

describe('starchIn', () => {
  const byId = new Map(products.map((each) => [each.id, each]));

  it("estimates a starch's carbs per serving from its packages", () => {
    expect(starchIn(recipe(1, 'Tofu Rice', 4), byId)).toEqual([{ product: 'Brown Rice Quinoa Blend', carbs: 41, credits: 4 }]);
  });

  it("counts one portion per serving when the whole package can't fit the recipe's carbs, like 4 buns from an 8-pack", () => {
    const burger = recipe(2, 'Burger', 4, { carbs: 44, uses: [BUNS] });

    expect(starchIn(burger, byId)).toEqual([{ product: 'Multigrain Buns', carbs: 33, credits: 4 }]);
  });
});

describe('boxCandidates', () => {
  it('offers 4-serving recipes, and 2-serving ones added twice when there is no cheaper 4-serving version', () => {
    const candidates = boxCandidates(
      [recipe(10, 'Tofu Rice', 4, { credits: 14 })],
      [recipe(11, 'Tofu Rice', 2, { credits: 8 }), recipe(12, 'Bean Tacos', 2, { credits: 9 })],
      products,
    );

    expect(candidates.map(({ recipe: { id }, times, credits }) => ({ id, times, credits }))).toEqual([
      { id: 10, times: 1, credits: 14 },
      { id: 12, times: 2, credits: 18 },
    ]);
  });

  it('keeps the 2-serving version twice when it costs less than the 4-serving one', () => {
    const [candidate] = boxCandidates([recipe(10, 'Tofu Rice', 4, { credits: 20 })], [recipe(11, 'Tofu Rice', 2, { credits: 8 })], products);

    expect(candidate).toMatchObject({ times: 2, credits: 16 });
  });

  it('works out the carbs left without the starch', () => {
    const [candidate] = boxCandidates([recipe(10, 'Tofu Rice', 4)], [], products);

    expect(candidate?.carbsWithoutStarch).toBe(21);
  });
});

describe('rankCandidates', () => {
  const candidates = boxCandidates(
    [
      recipe(1, 'Lean', 4, { protein: 30, kcal: 300, uses: [TOFU] }),
      recipe(2, 'Rich', 4, { protein: 30, kcal: 600, uses: [TOFU] }),
      recipe(3, 'Starchy', 4, { protein: 28, kcal: 400, carbs: 62 }),
    ],
    [],
    products,
  );
  const names = (ranked: ReturnType<typeof rankCandidates>) => ranked.map(({ recipe: { name } }) => name);

  it('puts the most protein per calorie first', () => {
    expect(names(rankCandidates(candidates, {}))).toEqual(['Lean', 'Starchy', 'Rich']);
  });

  it('filters by protein, by carbs after the starch is swapped out, and by name', () => {
    expect(names(rankCandidates(candidates, { minProtein: 29 }))).toEqual(['Lean', 'Rich']);
    expect(names(rankCandidates(candidates, { maxCarbs: 30 }))).toEqual(['Starchy']);
    expect(names(rankCandidates(candidates, { exclude: ['lean'] }))).toEqual(['Starchy', 'Rich']);
  });
});

describe('findRecipe', () => {
  const catalog = [recipe(1, 'Tofu Rice', 2), recipe(2, 'Tofu Rice', 4)];

  it('finds a recipe by id, or by name preferring 4 servings', () => {
    expect(findRecipe({ hungryrootId: 1 }, catalog)?.id).toBe(1);
    expect(findRecipe({ title: 'tofu rice' }, catalog)?.id).toBe(2);
  });

  it('finds nothing it does not know', () => {
    expect(findRecipe({ hungryrootId: 99 }, catalog)).toBeNull();
    expect(findRecipe({ title: 'Mystery Bowl' }, catalog)).toBeNull();
  });
});

describe('recipeRecord', () => {
  const tofuRice = recipe(1, 'Tofu Rice', 4);
  const swaps = { removed: ['Brown Rice Quinoa Blend'], added: ['Organic Riced Cauliflower'] };

  it("keeps the catalog's recipe with this week's swaps", () => {
    expect(recipeRecord('2026-W47', tofuRice, swaps, undefined)).toEqual({
      id: '1',
      name: 'Tofu Rice',
      hungryrootId: 1,
      link: 'https://www.hungryroot.com/recipes/slug-1/',
      servings: 4,
      minutes: 10,
      nutrition: tofuRice.nutrition,
      products: tofuRice.products.map(({ name, brand, amount, credits }) => ({ name, brand, amount, credits })),
      steps: ['Cube the tofu.'],
      received: [{ week: '2026-W47', ...swaps }],
    });
  });

  it('adds each week it comes, replacing a second save of the same week', () => {
    const first = recipeRecord('2026-W47', tofuRice, swaps, undefined);
    const again = recipeRecord('2026-W47', tofuRice, { removed: [], added: [] }, first);
    const later = recipeRecord('2026-W49', tofuRice, swaps, again);

    expect(later.received).toEqual([
      { week: '2026-W47', removed: [], added: [] },
      { week: '2026-W49', ...swaps },
    ]);
  });
});

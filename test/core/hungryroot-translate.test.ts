import { describe, expect, it } from 'vitest';
import { catalogRecipe, miseTags, productLine, recipeHash, servableImage, statesWholeRecipe } from '../../src/core/hungryroot-translate.ts';
import type { HungryrootProduct, HungryrootRecipe } from '../../src/sources/hungryroot.ts';

const recipe = (overrides: Partial<HungryrootRecipe> = {}): HungryrootRecipe => ({
  id: 1957003,
  name: 'Roasted Veggie + Vegan Ranch Bowl',
  slug: 'roasted-veggie-vegan-ranch-bowl-1957003',
  servings: 2,
  credits: 8,
  minutes: 17,
  nutrition: { kcal: 660, protein: 13, carbs: 59, fat: 42, fiber: 12, sugar: null },
  tags: ['Vegan', 'Pescatarian', 'Most Popular', 'Oven', 'High fiber', 'Serving Size 2'],
  products: [
    { id: 470, name: 'Lentil Quinoa Rice Mix', brand: 'Hungryroot', amount: 1, credits: 2 },
    { id: 12, name: 'Hungryroot Cauliflower Florets', brand: 'Hungryroot', amount: 0.5, credits: 2 },
  ],
  steps: ['Preheat oven to 425°; roast 10 min', 'Divide to bowls'],
  featured: true,
  image: 'https://d219o304zcx1el.cloudfront.net/ai_gen_1.jpg',
  ...overrides,
});

describe('miseTags', () => {
  it('always tags hungryroot, keeps the useful filters once each, and drops the rest', () => {
    expect(miseTags(['Vegan', 'Pescatarian', 'Most Popular', '5 Minutes or Less', 'Quick recipes', 'Serving Size 2'])).toEqual([
      'hungryroot',
      'vegan',
      'quick',
    ]);
  });
});

describe('productLine', () => {
  it('names the product with its brand, once, and keeps the package count with no unit', () => {
    expect(productLine({ id: 1, name: 'Organic Extra Firm Tofu', brand: 'Hodo Soy', amount: 1, credits: 3 })).toEqual({
      amount: 1,
      name: 'Hodo Soy Organic Extra Firm Tofu',
    });
    expect(productLine({ id: 2, name: 'Hungryroot Florets', brand: 'Hungryroot', amount: 0.5, credits: 2 })).toEqual({
      amount: 0.5,
      name: 'Hungryroot Florets',
    });
  });
});

describe('servableImage', () => {
  it("keeps only https images from the host Mise allows", () => {
    expect(servableImage('https://d219o304zcx1el.cloudfront.net/a.jpg')).toBe('https://d219o304zcx1el.cloudfront.net/a.jpg');
    expect(servableImage('https://other.example/a.jpg')).toBeNull();
    expect(servableImage('http://d219o304zcx1el.cloudfront.net/a.jpg')).toBeNull();
    expect(servableImage('not a url')).toBeNull();
    expect(servableImage(null)).toBeNull();
  });
});

describe('catalogRecipe', () => {
  it("writes a Hungryroot recipe in Mise's recipe shape, with Hungryroot's own details beside it", () => {
    const link = 'https://www.hungryroot.com/recipes/roasted-veggie-vegan-ranch-bowl-1957003/';
    expect(catalogRecipe(recipe())).toEqual({
      id: 'roasted-veggie-vegan-ranch-bowl-1957003',
      title: 'Roasted Veggie + Vegan Ranch Bowl',
      titleLower: 'roasted veggie + vegan ranch bowl',
      description: link,
      servings: 2,
      tags: ['hungryroot', 'vegan', 'oven', 'high-fiber'],
      ingredientGroups: [
        {
          ingredients: [
            { amount: 1, name: 'Hungryroot Lentil Quinoa Rice Mix' },
            { amount: 0.5, name: 'Hungryroot Cauliflower Florets' },
          ],
        },
      ],
      steps: [
        { step: 1, title: 'Step 1', instruction: 'Preheat oven to 425°; roast 10 min', ingredients: null },
        { step: 2, title: 'Step 2', instruction: 'Divide to bowls', ingredients: null },
      ],
      images: ['https://d219o304zcx1el.cloudfront.net/ai_gen_1.jpg'],
      nutrition: { kcal: 660, protein: 13, carbs: 59, fat: 42, fiber: 12, proteinPct: 0.079, carbsPct: 0.358, fatPct: 0.573, basis: 'stated' },
      source: { kind: 'hungryroot', id: '1957003', url: link },
      hungryroot: {
        id: 1957003,
        credits: 8,
        minutes: 17,
        featured: true,
        gone: false,
        image: 'https://d219o304zcx1el.cloudfront.net/ai_gen_1.jpg',
        products: recipe().products,
      },
    });
  });

  it('stores each macro as a share of calories, so a scaled record ranks the same, and leaves shares out without calories', () => {
    const scaled = catalogRecipe(recipe({ nutrition: { kcal: 2640, protein: 52, carbs: 236, fat: 168, fiber: 48, sugar: null } }));
    const noCalories = catalogRecipe(recipe({ nutrition: { kcal: null, protein: 13, carbs: 59, fat: 42, fiber: 12, sugar: null } }));

    expect(scaled.nutrition?.proteinPct).toBe(catalogRecipe(recipe()).nutrition?.proteinPct);
    expect(noCalories.nutrition).toEqual({ protein: 13, carbs: 59, fat: 42, fiber: 12, basis: 'stated' });
  });

  it('always writes featured and gone as booleans, so Mise can query for recipes Hungryroot still sells', () => {
    const copy = catalogRecipe(recipe({ featured: false }));

    expect(copy.hungryroot).toMatchObject({ featured: false, gone: false });
  });

  it('leaves out images and nutrition it cannot give, rather than writing empty ones', () => {
    const copy = catalogRecipe(
      recipe({ image: 'https://elsewhere.example/a.jpg', nutrition: { kcal: null, protein: null, carbs: null, fat: null, fiber: null, sugar: null } }),
    );

    expect(copy).not.toHaveProperty('images');
    expect(copy).not.toHaveProperty('nutrition');
    expect(copy.hungryroot.image).toBe('https://elsewhere.example/a.jpg');
  });
});

describe('recipeHash', () => {
  it('changes when the copy would change, and only then', () => {
    expect(recipeHash(catalogRecipe(recipe()))).toBe(recipeHash(catalogRecipe(recipe())));
    expect(recipeHash(catalogRecipe(recipe({ credits: 9 })))).not.toBe(recipeHash(catalogRecipe(recipe())));
  });
});

const product = (id: number, kcal: number | null, servings: number): HungryrootProduct => ({
  id,
  name: `Product ${id}`,
  brand: null,
  credits: 2,
  category: null,
  servings,
  servingSize: null,
  perServing: kcal === null ? null : { kcal, protein: null, carbs: null },
  ingredients: null,
  dietaryTags: [],
});

const plate = (kcal: number, servings = 4): HungryrootRecipe =>
  recipe({
    servings,
    nutrition: { kcal, protein: 108, carbs: 226, fat: 105, fiber: 20, sugar: null },
    products: [
      { id: 1, name: 'Tenders', brand: null, amount: 1.5, credits: 4 },
      { id: 2, name: 'Fries', brand: null, amount: 1, credits: 2 },
    ],
  });

describe('statesWholeRecipe', () => {
  const products = new Map([
    [1, product(1, 250, 4)],
    [2, product(2, 300, 4)],
  ]);

  it("spots per-serving figures that are really the whole recipe's, by the products' own calories", () => {
    expect(statesWholeRecipe(plate(2280), products)).toBe(true);
  });

  it('leaves a genuinely large meal alone, an ordinary one whose products add up to about its figure, and anything it cannot check', () => {
    expect(statesWholeRecipe(plate(800), products)).toBe(false);
    expect(statesWholeRecipe(plate(1_200, 2), new Map([[1, product(1, 200, 4)], [2, product(2, 200, 2)]]))).toBe(false);
    expect(statesWholeRecipe(plate(2280), new Map([[1, product(1, 250, 4)]]))).toBe(false);
    expect(statesWholeRecipe(plate(2280), new Map([...products, [2, product(2, null, 4)]]))).toBe(false);
    expect(statesWholeRecipe(plate(2280, 1), products)).toBe(false);
  });

  it('divides whole-recipe figures by the servings, and says so', () => {
    const copy = catalogRecipe(plate(2280), products);

    expect(copy.nutrition).toEqual({
      kcal: 570,
      protein: 27,
      carbs: 56.5,
      fat: 26.3,
      fiber: 5,
      proteinPct: 0.189,
      carbsPct: 0.396,
      fatPct: 0.415,
      basis: 'stated',
    });
    expect(copy.hungryroot.nutritionWasWholeRecipe).toBe(true);
    expect(catalogRecipe(plate(800), products).hungryroot).not.toHaveProperty('nutritionWasWholeRecipe');
  });
});

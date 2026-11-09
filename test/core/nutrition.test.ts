import { describe, expect, it } from 'vitest';
import { lineGrams, recipeNutrition } from '../../src/core/nutrition.ts';
import type { Ingredient } from '../../src/data/recipes.ts';
import { entry, parsedLine, parseOf, recipeWith } from '../fakes.ts';

const weights = { gramsPerMl: 0.5, unitWeights: { piece: 300 } };
const none = { gramsPerMl: null, unitWeights: {} };

describe('lineGrams', () => {
  it.each([
    ['a weight', parseOf('flour', { amount: 2, unit: 'oz' }), weights, 56.699],
    ['a volume, through the density', parseOf('flour', { amount: 1, unit: 'cup' }), weights, 118.294],
    ['a package size by weight', parseOf('beans', { amount: 2, unit: 'can', packageSize: { amount: 15, unit: 'oz' } }), none, 850.485],
    ['a package size by volume', parseOf('broth', { amount: 1, unit: 'bottle', packageSize: { amount: 100, unit: 'ml' } }), weights, 50],
    ['a counted unit', parseOf('cucumber', { amount: 2, unit: 'piece' }), weights, 600],
  ])('weighs %s', (_label, parse, given, grams) => {
    expect(lineGrams(parse, given)).toBeCloseTo(grams, 2);
  });

  it.each([
    ['a volume with no density', parseOf('flour', { unit: 'cup' })],
    ['a counted unit with no weight', parseOf('garlic', { unit: 'clove' })],
  ])("can't weigh %s", (_label, parse) => {
    expect(lineGrams(parse, none)).toBeNull();
  });
});

describe('recipeNutrition', () => {
  const tofu: Ingredient = { amount: 200, unit: 'g', name: 'tofu' };
  const oil: Ingredient = { amount: 1, unit: 'tbsp', name: 'oil' };
  const salt: Ingredient = { amount: 1, unit: 'pinch', name: 'salt to taste' };
  const rice: Ingredient = { amount: 1, unit: 'cup', name: 'cooked rice' };
  const naan: Ingredient = { amount: 2, unit: 'piece', name: 'naan' };

  const lines = new Map(
    [
      parsedLine(tofu, parseOf('tofu', { amount: 200, unit: 'g' })),
      parsedLine(oil, parseOf('olive oil', { amount: 1, unit: 'tbsp' })),
      parsedLine(salt, parseOf('salt', { unit: 'pinch', toTaste: true })),
      parsedLine(rice, parseOf('rice', { unit: 'cup', measuredAs: 'cooked' })),
      parsedLine(naan, parseOf('flatbread', { amount: 2, unit: 'piece' })),
    ].map((parsed) => [parsed.key, parsed]),
  );
  const per100g = (kcal: number, protein: number) => ({ kcal, protein, carbs: 2, sugar: 1, fiber: 1, fat: 5 });
  const food = (kcal: number, protein: number) => ({ fdcId: kcal, description: 'x', per100g: per100g(kcal, protein), source: 'claude' as const, doubt: null });
  const entries = new Map(
    [
      entry('tofu', { food: food(100, 10) }),
      entry('olive oil', { food: food(900, 0), gramsPerMl: 0.9 }),
      entry('flatbread', { food: food(300, 9) }),
    ].map((saved) => [saved.name, saved]),
  );

  it('adds every line, counting a line repeated in two groups twice, and divides by servings', () => {
    const recipe = { ...recipeWith('bowl', [tofu, oil]), servings: 2, ingredientGroups: [{ ingredients: [tofu, oil] }, { ingredients: [oil] }] };
    const oilGrams = 2 * 14.7868 * 0.9;

    const { perServing, gaps } = recipeNutrition(recipe, lines, entries);

    expect(perServing?.kcal).toBe(Math.round((200 + oilGrams * 9) / 2));
    expect(perServing?.protein).toBe(10);
    expect(gaps).toEqual([]);
  });

  it('names each line left out, with its reason', () => {
    const unparsed: Ingredient = { amount: 1, unit: 'piece', name: 'mystery' };
    const recipe = recipeWith('plate', [tofu, salt, rice, naan, unparsed]);

    expect(recipeNutrition(recipe, lines, entries).gaps).toEqual([
      '1 pinch | salt to taste (to taste)',
      '1 cup | cooked rice (measured cooked)',
      '2 piece | naan (no weight for piece)',
      '1 piece | mystery (not parsed yet)',
    ]);
  });

  it('names the nutrients a counted food has no value for', () => {
    const beans: Ingredient = { amount: 100, unit: 'g', name: 'black beans' };
    const beanLine = parsedLine(beans, parseOf('canned black beans', { amount: 100, unit: 'g' }));
    const withBeans = new Map([...lines, [beanLine.key, beanLine]]);
    const beanFood = { ...food(118, 7), per100g: { kcal: 118, protein: 7, carbs: 20, sugar: null, fiber: null, fat: 1 } };
    const withEntries = new Map([...entries, ['canned black beans', entry('canned black beans', { food: beanFood })]]);

    expect(recipeNutrition(recipeWith('beans', [beans, tofu]), withBeans, withEntries).missing).toEqual(['canned black beans: sugar, fiber']);
  });

  it('has no estimate when no line could be counted', () => {
    expect(recipeNutrition(recipeWith('naan', [naan]), lines, entries).perServing).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { formatLine, lineKey, uniqueLines } from '../../src/core/ingredient-lines.ts';
import type { Recipe } from '../../src/data/recipes.ts';

const garlic = { amount: 2, unit: 'cloves', name: 'garlic, minced' };

describe('lineKey', () => {
  it('is the same for the same line, ignoring stray spaces', () => {
    expect(lineKey({ amount: 2, unit: ' cloves', name: 'garlic, minced ' })).toBe(lineKey(garlic));
  });

  it.each([
    ['amount', { ...garlic, amount: 3 }],
    ['unit', { ...garlic, unit: 'piece' }],
    ['name', { ...garlic, name: 'garlic, sliced' }],
  ])('changes when the %s changes', (_field, changed) => {
    expect(lineKey(changed)).not.toBe(lineKey(garlic));
  });
});

describe('formatLine', () => {
  it('shows amount, unit and name', () => {
    expect(formatLine({ amount: 2, unit: '', name: ' Bell peppers, sliced' })).toBe('2  | Bell peppers, sliced');
  });
});

describe('uniqueLines', () => {
  it('collects lines across groups, once each', () => {
    const recipe: Recipe = {
      id: 'r',
      title: 'R',
      description: '',
      servings: 2,
      tags: [],
      ingredientGroups: [{ ingredients: [garlic, { amount: 1, unit: 'tsp', name: 'salt' }] }, { ingredients: [garlic] }],
    };

    expect(uniqueLines(recipe).map(({ line }) => line.name)).toEqual(['garlic, minced', 'salt']);
  });
});

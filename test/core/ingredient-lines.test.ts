import { describe, expect, it } from 'vitest';
import { formatLine, lineKey, recipesWithLine, uniqueLines } from '../../src/core/ingredient-lines.ts';
import type { Recipe } from '../../src/data/recipes.ts';

const garlic = { amount: 2, unit: 'cloves', name: 'garlic, minced' };

describe('lineKey', () => {
  it.each([
    ['stray spaces', { amount: 2, unit: ' cloves', name: 'garlic,  minced ' }],
    ['letter case', { amount: 2, unit: 'Cloves', name: 'Garlic, Minced' }],
    ['a trailing full stop', { amount: 2, unit: 'cloves', name: 'garlic, minced.' }],
    ['a unit spelled out or singular', { amount: 2, unit: 'clove', name: 'garlic, minced' }],
  ])('is the same line despite %s', (_label, line) => {
    expect(lineKey(line)).toBe(lineKey(garlic));
  });

  it('treats unit spellings alike', () => {
    expect(lineKey({ amount: 1, unit: 'Tablespoons', name: 'oil' })).toBe(lineKey({ amount: 1, unit: 'tbsp.', name: 'oil' }));
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

describe('recipesWithLine', () => {
  it('names the recipes that use a line, however it is spelled', () => {
    const recipe = (id: string, lines: { amount: number; unit: string; name: string }[]): Recipe => ({
      id,
      title: id,
      description: '',
      servings: 2,
      tags: [],
      ingredientGroups: [{ ingredients: lines }],
    });

    expect(recipesWithLine([recipe('a', [garlic]), recipe('b', [{ ...garlic, name: 'Garlic, minced' }]), recipe('c', [])], garlic)).toEqual(['a', 'b']);
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

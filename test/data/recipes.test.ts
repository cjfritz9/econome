import { describe, expect, it } from 'vitest';
import { readLibrary, withTag, type RecipeDoc } from '../../src/data/recipes.ts';

const tofu = { amount: 14, unit: 'oz', name: 'extra-firm tofu' };

const recipeDoc = (id: string, overrides: Record<string, unknown> = {}): RecipeDoc => ({
  id,
  data: {
    title: id,
    description: `About ${id}`,
    servings: 4,
    tags: ['vegan'],
    ingredientGroups: [{ label: 'Main', ingredients: [tofu] }],
    ...overrides,
  },
});

const ids = (docs: RecipeDoc[]) => readLibrary(docs).recipes.map((recipe) => recipe.id);

describe('readLibrary', () => {
  it('returns each meal with its ingredient groups, sorted by title', () => {
    const library = readLibrary([recipeDoc('Teriyaki Tofu'), recipeDoc('Coconut Rice Bowls')]);

    expect(library.skipped).toEqual([]);
    expect(library.skippedLines).toEqual([]);
    expect(library.recipes).toEqual([
      {
        id: 'Coconut Rice Bowls',
        title: 'Coconut Rice Bowls',
        description: 'About Coconut Rice Bowls',
        servings: 4,
        tags: ['vegan'],
        ingredientGroups: [{ ingredients: [tofu] }],
      },
      expect.objectContaining({ id: 'Teriyaki Tofu' }),
    ]);
  });

  it('leaves out archived recipes', () => {
    expect(ids([recipeDoc('kept', { archived: false }), recipeDoc('gone', { archived: true })])).toEqual(['kept']);
  });

  it('leaves out recipes tagged not-a-meal without reporting them', () => {
    const library = readLibrary([recipeDoc('French Press', { tags: ['coffee', 'not-a-meal'] })]);

    expect(library).toEqual({ recipes: [], skipped: [], skippedLines: [] });
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['an empty list', []],
    ['only empty groups', [{ ingredients: [] }, { ingredients: null }]],
    ['only blank rows', [{ ingredients: [{ amount: 0, unit: '', name: '' }, { amount: 0, unit: '', name: '  ' }] }]],
  ])('reports a recipe whose ingredient groups are %s', (_label, ingredientGroups) => {
    const library = readLibrary([recipeDoc('Bare', { ingredientGroups })]);

    expect(library.recipes).toEqual([]);
    expect(library.skipped).toEqual([{ id: 'Bare', reason: 'Has no ingredients' }]);
  });

  it('treats null tags and description as empty', () => {
    const [recipe] = readLibrary([recipeDoc('Plain', { tags: null, description: null })]).recipes;

    expect(recipe).toMatchObject({ tags: [], description: '' });
  });

  it('reads a line with no unit as a count', () => {
    const peppers = { amount: 2, unit: '', name: 'bell peppers, sliced' };
    const [recipe] = readLibrary([recipeDoc('Curry', { ingredientGroups: [{ ingredients: [peppers] }] })]).recipes;

    expect(recipe?.ingredientGroups).toEqual([{ ingredients: [peppers] }]);
  });

  it('keeps a line with no amount, such as one to taste', () => {
    const salt = { amount: 0, unit: '', name: 'salt, to taste' };
    const [recipe] = readLibrary([recipeDoc('Curry', { ingredientGroups: [{ ingredients: [tofu, salt] }] })]).recipes;

    expect(recipe?.ingredientGroups).toEqual([{ ingredients: [tofu, salt] }]);
  });

  it('leaves out a blank row and reports it', () => {
    const blank = { amount: 0, unit: '', name: ' ' };
    const library = readLibrary([recipeDoc('Curry', { ingredientGroups: [{ ingredients: [tofu, blank] }] })]);

    expect(library.recipes[0]?.ingredientGroups).toEqual([{ ingredients: [tofu] }]);
    expect(library.skippedLines).toEqual([{ id: 'Curry', line: JSON.stringify(blank), reason: 'A blank row with no ingredient name' }]);
  });

  it('leaves out a line it cannot read, reports it and keeps the recipe', () => {
    const rice = { amount: -1, unit: 'cup', name: 'rice' };
    const library = readLibrary([recipeDoc('Bowl', { ingredientGroups: [{ ingredients: [tofu, rice] }] })]);

    expect(library.recipes[0]?.ingredientGroups).toEqual([{ ingredients: [tofu] }]);
    expect(library.skippedLines).toEqual([{ id: 'Bowl', line: JSON.stringify(rice), reason: expect.stringMatching(/amount/) }]);
  });

  it('reports a recipe it cannot read and keeps the rest', () => {
    const library = readLibrary([recipeDoc('Broken', { servings: 0 }), recipeDoc('Fine')]);

    expect(library.recipes.map((recipe) => recipe.id)).toEqual(['Fine']);
    expect(library.skipped).toEqual([{ id: 'Broken', reason: expect.stringMatching(/^Can't be read:.*servings/s) }]);
  });
});

describe('withTag', () => {
  it('keeps recipes with the tag, in any letter case', () => {
    const { recipes } = readLibrary([
      recipeDoc('Tacos', { tags: ['Mexican', 'vegan'] }),
      recipeDoc('Satay', { tags: ['asian'] }),
    ]);

    expect(withTag(recipes, 'mexican').map((recipe) => recipe.id)).toEqual(['Tacos']);
  });
});

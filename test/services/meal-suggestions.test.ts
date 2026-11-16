import { describe, expect, it } from 'vitest';
import type { CalendarWeek } from '../../src/core/calendar.ts';
import type { Household } from '../../src/data/household.ts';
import type { RecipeDoc } from '../../src/data/recipes.ts';
import { mealSuggestionService } from '../../src/services/meal-suggestions.ts';
import { answeringClaude, memoryIngredients, memoryNotes, memoryParsedLines, memoryWeeks } from '../fakes.ts';

const WEEK: CalendarWeek = { id: '2026-W47', start: '2026-11-16', end: '2026-11-22' };
const household: Household = {
  id: 'h1',
  name: 'Home',
  members: ['uid1', 'uid2'],
  settings: { timezone: 'America/New_York', mealTargets: { dinner: 12, lunch: 8 } },
};
const DIRECTIVE = { path: 'directives/general.md', content: 'Maximize protein.', updatedBy: 'uid1', updatedAt: '2026-11-09T00:00:00.000Z' };

const doc = (id: string, servings = 4, tags: string[] = []): RecipeDoc => ({
  id,
  data: { title: `Recipe ${id}`, description: '', servings, tags, ingredientGroups: [{ ingredients: [{ amount: 1, unit: 'cup', name: 'lentils' }] }] },
});
const LIBRARY = [doc('tempeh'), doc('tofu'), doc('chili'), doc('oats', 2, ['breakfast'])];

const setup = ({ answer = (): unknown => ({ picks: [] }), notes = [DIRECTIVE], saved = {} as Record<string, unknown> } = {}) => {
  const { claude, prompts } = answeringClaude(answer);
  const weeks = memoryWeeks({
    '2026-W47': { meals: [], hungryroot: [{ title: 'Box Bowl', servings: 4 }], ...saved },
    '2026-W45': { meals: [{ recipeId: 'chili', title: 'Recipe chili', servings: 4 }] },
  });
  const service = mealSuggestionService({
    recipes: { listRecipeDocs: async () => LIBRARY },
    weeks: weeks.store,
    parsedLines: memoryParsedLines().store,
    ingredients: memoryIngredients().store,
    notes: memoryNotes(notes).store,
    claude,
    now: () => new Date('2026-11-15T12:00:00Z'),
  });
  return { service, prompts, weeks };
};

const picks = { picks: [{ id: 'tofu', slot: 'dinner', why: ['tofu'] }, { id: 'nope', slot: 'dinner', why: [] }, { id: 'tempeh', slot: 'dinner', why: ['tempeh'] }] };

describe('mealSuggestionService', () => {
  it('works out what the box leaves, and ranks the library by the directive', async () => {
    const { service, prompts } = setup({ answer: () => picks });

    const result = await service.suggest(household, WEEK);

    expect(result.left).toEqual({ breakfast: 0, lunch: 6, dinner: 10 });
    expect(result.rankedBy).toBe('directive');
    expect(result.suggestions).toEqual([
      { recipeId: 'tofu', slot: 'dinner', servings: 4, why: ['tofu'] },
      { recipeId: 'tempeh', slot: 'dinner', servings: 4, why: ['tempeh'] },
    ]);
    expect(prompts[0]).toContain("This week's Hungryroot box: Box Bowl");
    expect(prompts[0]).toContain('chili | Recipe chili | 4 | no tags | no estimate yet | 2026-11-02');
  });

  it('takes the unsaved draft into account without asking Claude again', async () => {
    const { service, prompts } = setup({ answer: () => picks });

    await service.suggest(household, WEEK);
    const result = await service.suggest(household, WEEK, [{ recipeId: 'tofu' }]);

    expect(prompts).toHaveLength(1);
    expect(result.left).toEqual({ breakfast: 0, lunch: 4, dinner: 8 });
    expect(result.suggestions.map(({ recipeId }) => recipeId)).toEqual(['tempeh']);
  });

  it("saves the week's ranking, and makes a new one only when asked", async () => {
    const { service, prompts, weeks } = setup({ answer: () => picks });

    await service.suggest(household, WEEK);
    await service.suggest(household, WEEK, [{ recipeId: 'tofu' }]);
    const renewed = await service.suggest(household, WEEK, undefined, { renew: true });

    expect(prompts).toHaveLength(2);
    expect(renewed.madeAt).toBe('2026-11-15T12:00:00.000Z');
    expect(weeks.docs.get('2026-W47')?.suggestions).toMatchObject({ meals: { picks: [{ recipeId: 'tofu' }, { recipeId: 'tempeh' }] } });
  });

  it('suggests nothing once the week is covered', async () => {
    const { service } = setup({ answer: () => picks });

    const smallWeek = { ...household, settings: { ...household.settings, mealTargets: { dinner: 6, lunch: 6 } } };

    const result = await service.suggest(smallWeek, WEEK, [{ recipeId: 'tofu' }, { recipeId: 'tempeh' }]);

    expect(result.left).toEqual({ breakfast: 0, lunch: 0, dinner: 0 });
    expect(result.suggestions).toEqual([]);
  });

  it('falls back with a warning when Claude cannot rank, or there is no directive', async () => {
    const failing = setup({
      answer: () => {
        throw new Error('spent');
      },
    });
    const withoutDirective = setup({ notes: [] });

    expect(await failing.service.suggest(household, WEEK)).toMatchObject({ rankedBy: 'protein', warning: expect.stringContaining('just now') });
    expect(await withoutDirective.service.suggest(household, WEEK)).toMatchObject({ rankedBy: 'protein', warning: expect.stringContaining('no planning directive') });
    expect(withoutDirective.prompts).toEqual([]);
  });
});

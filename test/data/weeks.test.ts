import { describe, expect, it } from 'vitest';
import { weekOf } from '../../src/core/calendar.ts';
import type { Recipe } from '../../src/data/recipes.ts';
import { lastPlannedDates, loadWeeks, planMeals, type PlannedMeal, type Weeks } from '../../src/data/weeks.ts';

const recipe = (id: string, servings: number): Recipe => ({
  id,
  title: `Title of ${id}`,
  description: '',
  servings,
  tags: [],
  ingredientGroups: [],
});

const library = [recipe('tofu-steaks', 2), recipe('rice-bowls', 4)];

const meal = (recipeId: string): PlannedMeal => ({ recipeId, title: recipeId, servings: 2 });

describe('planMeals', () => {
  it("fills in the title, and the recipe's own servings when none are given", () => {
    expect(planMeals(library, [{ recipeId: 'rice-bowls' }])).toEqual([
      { recipeId: 'rice-bowls', title: 'Title of rice-bowls', servings: 4 },
    ]);
  });

  it('keeps the servings and day it is given', () => {
    expect(planMeals(library, [{ recipeId: 'tofu-steaks', servings: 6, day: 'tuesday' }])).toEqual([
      { recipeId: 'tofu-steaks', title: 'Title of tofu-steaks', servings: 6, day: 'tuesday' },
    ]);
  });

  it('leaves day out entirely when there is none, so nothing undefined is written', () => {
    const [planned] = planMeals(library, [{ recipeId: 'tofu-steaks' }]);

    expect(planned).not.toHaveProperty('day');
  });

  it('allows the same recipe twice in a week', () => {
    expect(planMeals(library, [{ recipeId: 'tofu-steaks' }, { recipeId: 'tofu-steaks' }])).toHaveLength(2);
  });

  it('names every recipe it cannot plan, once each', () => {
    const requests = [{ recipeId: 'brew-guide' }, { recipeId: 'tofu-steaks' }, { recipeId: 'brew-guide' }];

    expect(() => planMeals(library, requests)).toThrow(/can be planned: brew-guide\. Use ids/);
  });
});

describe('loadWeeks', () => {
  const store = (docs: Record<string, unknown>): Weeks => ({
    findWeekDocs: async (_householdId, weekIds) =>
      weekIds.filter((id) => id in docs).map((id) => ({ id, data: docs[id] })),
    saveMeals: async () => {},
  });

  it('returns every week asked for, empty when nothing is planned', async () => {
    const weeks = [weekOf('2026-11-09'), weekOf('2026-11-02')];
    const loaded = await loadWeeks(store({ '2026-W46': { meals: [meal('tofu-steaks')] } }), 'h1', weeks);

    expect(loaded).toEqual([
      { week: weeks[0], meals: [meal('tofu-steaks')] },
      { week: weeks[1], meals: [] },
    ]);
  });

  it('reads a week without meals as empty', async () => {
    const [loaded] = await loadWeeks(store({ '2026-W46': { meals: null } }), 'h1', [weekOf('2026-11-09')]);

    expect(loaded?.meals).toEqual([]);
  });
});

describe('lastPlannedDates', () => {
  it('gives the start of the latest week each recipe was planned for', () => {
    const latest = lastPlannedDates([
      { week: weekOf('2026-11-02'), meals: [meal('tofu-steaks'), meal('rice-bowls')] },
      { week: weekOf('2026-11-09'), meals: [meal('tofu-steaks')] },
    ]);

    expect(Object.fromEntries(latest)).toEqual({ 'tofu-steaks': '2026-11-09', 'rice-bowls': '2026-11-02' });
  });
});

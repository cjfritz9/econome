import { describe, expect, it } from 'vitest';
import { weekOf } from '../../src/core/calendar.ts';
import type { Recipe } from '../../src/data/recipes.ts';
import {
  lastPlannedDates,
  loadWeeks,
  planMeals,
  weekCoverage,
  type HungryrootMeal,
  type PlannedMeal,
  type Weeks,
} from '../../src/data/weeks.ts';

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
  it("fills in the title and the recipe's own servings", () => {
    expect(planMeals(library, [{ recipeId: 'rice-bowls' }])).toEqual([
      { recipeId: 'rice-bowls', title: 'Title of rice-bowls', servings: 4 },
    ]);
  });

  it('keeps the day it is given', () => {
    expect(planMeals(library, [{ recipeId: 'tofu-steaks', day: 'tuesday' }])).toEqual([
      { recipeId: 'tofu-steaks', title: 'Title of tofu-steaks', servings: 2, day: 'tuesday' },
    ]);
  });

  it('leaves day out entirely when there is none, so nothing undefined is written', () => {
    const [planned] = planMeals(library, [{ recipeId: 'tofu-steaks' }]);

    expect(planned).not.toHaveProperty('day');
  });

  it('keeps which meal it is eaten as', () => {
    expect(planMeals(library, [{ recipeId: 'rice-bowls', slot: 'lunch' }])).toEqual([
      { recipeId: 'rice-bowls', title: 'Title of rice-bowls', servings: 4, slot: 'lunch' },
    ]);
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
    savePlan: async () => {},
    saveHave: async () => {},
    saveHungryroot: async () => {},
    lockBox: async () => {},
  });

  it('returns every week asked for, empty when nothing is planned', async () => {
    const weeks = [weekOf('2026-11-09'), weekOf('2026-11-02')];
    const loaded = await loadWeeks(store({ '2026-W46': { meals: [meal('tofu-steaks')] } }), 'h1', weeks);

    expect(loaded).toEqual([
      { week: weeks[0], meals: [meal('tofu-steaks')], hungryroot: [], targets: {}, have: {}, boxLocked: false },
      { week: weeks[1], meals: [], hungryroot: [], targets: {}, have: {}, boxLocked: false },
    ]);
  });

  it("reads the Hungryroot box's recipes and the week's own targets", async () => {
    const box: HungryrootMeal[] = [{ title: 'Glow bowl', servings: 2 }];
    const [loaded] = await loadWeeks(store({ '2026-W46': { meals: [], hungryroot: box, targets: { lunch: 6 } } }), 'h1', [
      weekOf('2026-11-09'),
    ]);

    expect(loaded).toMatchObject({ hungryroot: box, targets: { lunch: 6 } });
  });

  it("reads the week's have answers", async () => {
    const [loaded] = await loadWeeks(store({ '2026-W46': { meals: [], have: { 'soy sauce': false } } }), 'h1', [weekOf('2026-11-09')]);

    expect(loaded?.have).toEqual({ 'soy sauce': false });
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

describe('weekCoverage', () => {
  const cooked = (servings: number, slot?: PlannedMeal['slot']): PlannedMeal => ({
    recipeId: 'r',
    title: 'r',
    servings,
    ...(slot && { slot }),
  });
  const box = (servings: number): HungryrootMeal => ({ title: 'h', servings });

  it('counts a dinner once for each person, and its other servings as lunch leftovers', () => {
    const coverage = weekCoverage({ meals: [cooked(6)], hungryroot: [] }, 2, {});

    expect(coverage.dinner).toEqual({ planned: 2, fromHungryroot: 0, fromLeftovers: 0 });
    expect(coverage.lunch).toEqual({ planned: 4, fromHungryroot: 0, fromLeftovers: 4 });
  });

  it('counts a meal planned as lunch or breakfast entirely there', () => {
    const coverage = weekCoverage({ meals: [cooked(4, 'lunch'), cooked(2, 'breakfast')], hungryroot: [] }, 2, {});

    expect(coverage.lunch.planned).toBe(4);
    expect(coverage.breakfast.planned).toBe(2);
    expect(coverage.dinner.planned).toBe(0);
  });

  it("counts the Hungryroot box's recipes and says how much of each meal they cover", () => {
    const coverage = weekCoverage({ meals: [cooked(4)], hungryroot: [box(2), box(2)] }, 2, {});

    expect(coverage.dinner).toEqual({ planned: 6, fromHungryroot: 4, fromLeftovers: 0 });
    expect(coverage.lunch).toEqual({ planned: 2, fromHungryroot: 0, fromLeftovers: 2 });
  });

  it('compares each meal with its target, showing what is left to plan or over', () => {
    const coverage = weekCoverage({ meals: [cooked(6)], hungryroot: [box(2)] }, 2, { dinner: 12, lunch: 3, breakfast: 0 });

    expect(coverage.dinner).toMatchObject({ planned: 4, target: 12, leftToPlan: 8 });
    expect(coverage.lunch).toMatchObject({ planned: 4, target: 3, over: 1 });
    expect(coverage.breakfast).toEqual({ planned: 0, fromHungryroot: 0, fromLeftovers: 0, target: 0 });
  });

  it('leaves the target out for meals without one', () => {
    expect(weekCoverage({ meals: [], hungryroot: [] }, 2, {}).dinner).not.toHaveProperty('target');
  });
});

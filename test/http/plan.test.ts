import { describe, expect, it } from 'vitest';
import type { RecipeDoc } from '../../src/data/recipes.ts';
import { DATE, RESEARCH_ROUTINE, setup, WEEK } from './harness.ts';

const unread: RecipeDoc = {
  id: 'r2',
  data: { title: 'Lemongrass Noodles', description: '', servings: 4, tags: [], ingredientGroups: [{ ingredients: [{ amount: 2, unit: 'tsp', name: 'lemongrass' }] }] },
};
const archived: RecipeDoc = { id: 'r3', data: { ...unread.data as object, title: 'Old Soup', archived: true } };

describe('GET /api/recipes/facts', () => {
  it('gives each plannable recipe its estimate, unread lines and when it was last planned', async () => {
    const { call } = setup({ moreRecipes: [unread, archived] });

    const { status, body } = await call('GET', '/recipes/facts');

    expect(status).toBe(200);
    expect(body).toEqual({
      recipes: {
        r1: { perServing: null, estimate: 'none', unreadLines: 0, lastPlanned: '2026-11-09', notAgain: false },
        r2: { perServing: null, estimate: 'none', unreadLines: 1, lastPlanned: null, notAgain: false },
      },
    });
  });
});

describe('PUT /api/weeks/:date/meals', () => {
  it('saves the week, builds its list, and looks up the items without a product', async () => {
    const { call, fired, weeks, prompts } = setup({ planned: false });

    const { status, body } = await call('PUT', `/weeks/${DATE}/meals`, { meals: [{ recipeId: 'r1', slot: 'dinner' }, { recipeId: 'r1' }] });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      week: { id: WEEK },
      saved: true,
      meals: [
        { recipeId: 'r1', title: 'Tofu Scramble', servings: 2, slot: 'dinner' },
        { recipeId: 'r1', title: 'Tofu Scramble', servings: 2, slot: 'dinner' },
      ],
      shop: { state: 'list' },
      lookup: { kind: 'lookup', state: 'running', progress: { done: 0, total: 1 } },
      warnings: [],
    });
    expect(weeks.docs.get(WEEK)).toMatchObject({ plannedBy: 'uid1' });
    expect(fired).toEqual([{ trigger: RESEARCH_ROUTINE, payload: expect.objectContaining({ items: [{ id: 'lemon', term: 'lemon', for: 'lemon' }] }) }]);
    expect(prompts).toEqual([]);
  });

  it("doesn't look up again what a lookup already covers, so saving twice fires one routine", async () => {
    const { call, fired } = setup({ planned: false });

    await call('PUT', `/weeks/${DATE}/meals`, { meals: [{ recipeId: 'r1' }] });
    const again = await call('PUT', `/weeks/${DATE}/meals`, { meals: [{ recipeId: 'r1' }, { recipeId: 'r1', slot: 'lunch' }] });

    expect(again.body).toMatchObject({ lookup: null, warnings: [] });
    expect(fired).toHaveLength(1);
  });

  it('keeps the week saved and says so when lookups are not set up', async () => {
    const { call } = setup({ planned: false, researchRoutine: null });

    const { status, body } = await call('PUT', `/weeks/${DATE}/meals`, { meals: [{ recipeId: 'r1' }] });

    expect(status).toBe(200);
    expect(body).toMatchObject({ saved: true, lookup: null, warnings: [{ message: "Lookups aren't set up on this server." }] });
  });

  it('clears the week with no meals, and turns away a recipe that cannot be planned', async () => {
    const { call, fired } = setup();

    expect((await call('PUT', `/weeks/${DATE}/meals`, { meals: [{ recipeId: 'r3' }] })).status).toBe(400);
    expect((await call('PUT', `/weeks/${DATE}/meals`, { meals: [] })).body).toMatchObject({ saved: false, meals: [], lookup: null });
    expect(fired).toEqual([]);
  });
});

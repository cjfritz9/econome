import { describe, expect, it } from 'vitest';
import type { CalendarWeek } from '../../src/core/calendar.ts';
import type { Household } from '../../src/data/household.ts';
import type { StoredCatalogRecipe } from '../../src/data/hungryroot-catalog.ts';
import type { HungryrootProduct } from '../../src/sources/hungryroot.ts';
import { boxSuggestionService } from '../../src/services/box-suggestions.ts';
import { answeringClaude, memoryNotes, memoryWeeks } from '../fakes.ts';

const WEEK: CalendarWeek = { id: '2026-W48', start: '2026-11-23', end: '2026-11-29' };
const household: Household = { id: 'h1', name: 'Home', members: ['uid1'], settings: { timezone: 'America/New_York', hungryroot: { boxServings: 12 } } };
const DIRECTIVE = { path: 'directives/general.md', content: 'Maximize protein; lean lower-carb.', updatedBy: 'uid1', updatedAt: '2026-11-09T00:00:00.000Z' };

const recipe = (
  id: string,
  servings: number,
  { protein = 32, kcal = 500, carbs = 50, fat = 12, featured = true, gone = false, title = id } = {},
): StoredCatalogRecipe => ({
  id,
  title,
  servings,
  steps: [],
  nutrition: { kcal, protein, carbs, fat, fiber: 8 },
  hungryroot: { id: id.length, credits: 9, minutes: 12, featured, gone, image: null, products: [] },
});

const CATALOG = [
  recipe('tofu-bowl', 4, { protein: 35, kcal: 520 }),
  recipe('tempeh-tacos', 2, { protein: 30 }),
  recipe('dropped-curry', 4, { gone: true }),
  recipe('hidden-salad', 4, { featured: false }),
  recipe('light-soup', 4, { protein: 15, kcal: 300, carbs: 40, fat: 5 }),
  recipe('last-weeks-burger', 4, { title: 'Last Week Burger' }),
  recipe('this-weeks-noodles', 4, { title: 'This Week Noodles' }),
];

const offeredIn = (prompt: string) =>
  prompt
    .split('\n')
    .filter((line) => line.includes(' | ') && !line.startsWith('Candidates'))
    .map((line) => line.split(' | ')[0] ?? '');

const setup = ({
  answer = (): unknown => ({ picks: [] }) as unknown,
  notes = [DIRECTIVE],
  catalog = CATALOG,
  products = [] as HungryrootProduct[],
}: { answer?: (prompt: string) => unknown; notes?: (typeof DIRECTIVE)[]; catalog?: StoredCatalogRecipe[]; products?: HungryrootProduct[] } = {}) => {
  const { claude, prompts } = answeringClaude(answer);
  const weeks = memoryWeeks({
    '2026-W47': { hungryroot: [{ title: 'Last Week Burger', servings: 4 }] },
    '2026-W48': { hungryroot: [{ title: 'This Week Noodles', servings: 4 }] },
  });
  const service = boxSuggestionService({
    catalog: { recentRuns: async () => [], allRecipes: async () => catalog, allProducts: async () => products },
    weeks: weeks.store,
    notes: memoryNotes(notes).store,
    claude,
    now: () => new Date('2026-11-15T12:00:00Z'),
  });
  return { service, prompts, weeks };
};

describe('boxSuggestionService', () => {
  it("ranks the shortlist by the household's directive, in Claude's order, with its reasons", async () => {
    const { service, prompts } = setup({
      answer: () => ({
        picks: [
          { id: 'tempeh-tacos', why: ['30 g protein', 'quick'] },
          { id: 'not-a-candidate', why: ['x'] },
          { id: 'tofu-bowl', why: ['35 g protein'] },
        ],
      }),
    });

    const result = await service.suggest(household, WEEK);

    expect(result).toMatchObject({ boxServings: 12, chosenServings: 4, wanted: 2, rankedBy: 'directive', directive: 'directives/general.md' });
    expect(result.suggestions).toEqual([
      { id: 'tempeh-tacos', times: 2, servings: 4, credits: 18, why: ['30 g protein', 'quick'] },
      { id: 'tofu-bowl', times: 1, servings: 4, credits: 9, why: ['35 g protein'] },
    ]);
    expect(prompts[0]).toContain('Maximize protein; lean lower-carb.');
  });

  it('leaves out recipes in this or recent boxes, dropped or hidden ones, and low-protein ones', async () => {
    const { service, prompts } = setup();

    await service.suggest(household, WEEK);

    const offered = (prompts[0] ?? '').split('\n').filter((line) => line.includes(' | ') && !line.startsWith('Candidates')).map((line) => line.split(' | ')[0]);
    expect(offered.sort()).toEqual(['tempeh-tacos', 'tofu-bowl']);
  });

  it("saves the week's list, shows it until asked for a new one, and hides recipes added to the box since", async () => {
    const { service, prompts, weeks } = setup({ answer: (prompt: string) => ({ picks: offeredIn(prompt).map((id) => ({ id, why: [] })) }) });

    const first = await service.suggest(household, WEEK);
    weeks.docs.set('2026-W48', { ...weeks.docs.get('2026-W48'), hungryroot: [{ title: 'This Week Noodles', servings: 4, slug: 'tofu-bowl' }] });
    const again = await service.suggest(household, WEEK);

    expect(first).toMatchObject({ madeAt: '2026-11-15T12:00:00.000Z' });
    expect(first.suggestions.map(({ id }) => id).sort()).toEqual(['tempeh-tacos', 'tofu-bowl']);
    expect(again.suggestions.map(({ id }) => id)).toEqual(['tempeh-tacos']);
    expect(prompts).toHaveLength(1);
  });

  it('makes each new list from recipes not shown before that week, and starts over once none are left', async () => {
    const { service, weeks } = setup({ answer: (prompt: string) => ({ picks: offeredIn(prompt).slice(0, 1).map((id) => ({ id, why: [] })) }) });

    const lists = [];
    for (const renew of [false, true, true]) lists.push((await service.suggest(household, WEEK, { renew })).suggestions.map(({ id }) => id));

    expect(lists[0]).toHaveLength(1);
    expect(lists[1]).toHaveLength(1);
    expect(lists[1]).not.toEqual(lists[0]);
    expect(lists[2]).toEqual(lists[0]);
    expect(weeks.docs.get('2026-W48')?.suggestions).toMatchObject({ box: { seen: [] } });
  });

  it('leaves out other versions of a dish already shown when making a new list', async () => {
    const tofu: HungryrootProduct = {
      id: 10,
      name: 'Japanese Teriyaki Saucy Tofu',
      brand: 'Hungryroot',
      credits: 3,
      category: 'Plant-Based Proteins',
      servings: 4,
      servingSize: null,
      perServing: null,
      ingredients: null,
      dietaryTags: [],
    };
    const withTofu = (id: string, protein: number) => {
      const made = recipe(id, 4, { protein });
      return { ...made, hungryroot: { ...made.hungryroot, products: [{ id: 10, name: tofu.name, brand: 'Hungryroot', amount: 1, credits: 3 }] } };
    };
    const { service } = setup({
      catalog: [withTofu('teriyaki-peppers', 36), withTofu('teriyaki-broccoli', 35), recipe('tempeh-tacos', 2, { protein: 30 })],
      products: [tofu],
      answer: (prompt: string) => ({ picks: offeredIn(prompt).slice(0, 1).map((id) => ({ id, why: [] })) }),
    });

    const first = await service.suggest(household, WEEK);
    const next = await service.suggest(household, WEEK, { renew: true });

    expect(first.suggestions.map(({ id }) => id)).toEqual(['teriyaki-peppers']);
    expect(next.suggestions.map(({ id }) => id)).toEqual(['tempeh-tacos']);
  });

  it("doesn't save a list it couldn't rank by the directive, so the next look tries again", async () => {
    let failing = true;
    const { service, prompts, weeks } = setup({
      answer: () => {
        if (failing) throw new Error('spent');
        return { picks: [{ id: 'tofu-bowl', why: [] }] };
      },
    });

    await service.suggest(household, WEEK);
    failing = false;
    const later = await service.suggest(household, WEEK);

    expect(prompts).toHaveLength(2);
    expect(later.rankedBy).toBe('directive');
    expect(weeks.docs.get('2026-W48')?.suggestions).toMatchObject({ box: { picks: [{ id: 'tofu-bowl' }] } });
  });

  it('keeps its picks, so opening the box again asks Claude nothing', async () => {
    const { service, prompts } = setup({ answer: () => ({ picks: [{ id: 'tofu-bowl', why: ['35 g protein'] }] }) });

    await service.suggest(household, WEEK);
    await service.suggest(household, WEEK);

    expect(prompts).toHaveLength(1);
  });

  it('falls back to protein per calorie, saying so, when Claude cannot rank them', async () => {
    const { service } = setup({
      answer: () => {
        throw new Error('spent');
      },
    });

    const result = await service.suggest(household, WEEK);

    expect(result.rankedBy).toBe('protein');
    expect(result.warning).toMatch(/ranked by protein per calorie/);
    expect(result.suggestions.map(({ id }) => id)).toEqual(['tofu-bowl', 'tempeh-tacos']);
    expect(result.suggestions[0]?.why).toEqual([]);
  });

  it('ranks by protein without asking Claude when there is no planning directive', async () => {
    const { service, prompts } = setup({ notes: [] });

    const result = await service.suggest(household, WEEK);

    expect(prompts).toEqual([]);
    expect(result).toMatchObject({ rankedBy: 'protein', warning: expect.stringContaining('no planning directive') });
  });
});

import { describe, expect, it } from 'vitest';
import type { CatalogRunRecord, StoredCatalogRecipe } from '../../src/data/hungryroot-catalog.ts';
import { DATE, setup, WEEK } from './harness.ts';

const counts = {
  read: 6542,
  of: 6542,
  complete: true,
  added: 0,
  updated: 3,
  unchanged: 6539,
  back: 0,
  gone: 1,
  products: 988,
  imageHostsLeftOff: [],
};

const runs: CatalogRunRecord[] = [
  { at: new Date('2026-12-01T09:00:00Z'), seconds: 150, error: null, counts },
  { at: new Date('2026-11-01T09:00:00Z'), seconds: 4, error: "Hungryroot's public catalog answered 503.", counts: null },
];

describe('GET /api/hungryroot/runs', () => {
  it('lists the catalog copy runs, newest first, failures included', async () => {
    const { status, body } = await setup({ catalogRuns: runs }).call('GET', '/hungryroot/runs');

    expect(status).toBe(200);
    expect(body).toEqual({
      runs: [
        { at: '2026-12-01T09:00:00.000Z', seconds: 150, ok: true, error: null, counts },
        { at: '2026-11-01T09:00:00.000Z', seconds: 4, ok: false, error: "Hungryroot's public catalog answered 503.", counts: null },
      ],
    });
  });

  it('takes a limit, and refuses one outside 1 to 24', async () => {
    const harness = setup({ catalogRuns: runs });

    expect(((await harness.call('GET', '/hungryroot/runs?limit=1')).body.runs as unknown[]).length).toBe(1);
    expect((await harness.call('GET', '/hungryroot/runs?limit=99')).status).toBe(400);
  });
});

const catalogRecipe = (id: string, overrides: Partial<StoredCatalogRecipe['hungryroot']> = {}): StoredCatalogRecipe => ({
  id,
  title: `Recipe ${id}`,
  servings: 2,
  steps: [{ instruction: 'Cook it' }],
  nutrition: { kcal: 500, protein: 30, carbs: 40, fat: 15 },
  hungryroot: { id: 100 + id.length, credits: 9, minutes: 12, featured: true, gone: false, image: null, products: [], ...overrides },
});

const TIKKA = catalogRecipe('tofu-tikka-1963829');
const GONE = catalogRecipe('old-bowl-5', { gone: true });

describe('PUT /api/weeks/:date/hungryroot', () => {
  it("records the household's box from the catalogue, with servings from the record times how often it was added", async () => {
    const harness = setup({ catalogRecipes: [TIKKA] });

    const { status, body } = await harness.call('PUT', `/weeks/${DATE}/hungryroot`, {
      recipes: [{ id: TIKKA.id, times: 2, removed: ['Organic Seasoned Jasmine Rice'], added: ['Riced Cauliflower'] }],
    });

    expect(status).toBe(200);
    expect(body.hungryroot).toEqual({
      state: 'confirmed',
      cutoff: '2026-11-05',
      recipes: [
        {
          id: TIKKA.id,
          hungryrootId: TIKKA.hungryroot.id,
          title: TIKKA.title,
          servings: 4,
          times: 2,
          removed: ['Organic Seasoned Jasmine Rice'],
          added: ['Riced Cauliflower'],
        },
      ],
    });
    expect(harness.boxRecords.get(String(TIKKA.hungryroot.id))).toMatchObject({
      name: TIKKA.title,
      received: [{ week: WEEK, removed: ['Organic Seasoned Jasmine Rice'], added: ['Riced Cauliflower'] }],
    });
  });

  it('keeps the week’s meals, and leaves the box out of the shopping list', async () => {
    const harness = setup({ catalogRecipes: [TIKKA] });

    const { body } = await harness.call('PUT', `/weeks/${DATE}/hungryroot`, { recipes: [{ id: TIKKA.id }] });

    expect(body.meals).toMatchObject([{ recipeId: 'r1' }]);
    const list = await harness.call('GET', `/weeks/${DATE}/list`);
    expect(list.status).toBe(200);
    expect((list.body.buy as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(list.body)).not.toContain(TIKKA.title);
  });

  it('sends back each recipe with how often it was added, so the box round-trips unchanged', async () => {
    const harness = setup({ catalogRecipes: [TIKKA, catalogRecipe('tempeh-bowl-7')] });
    await harness.call('PUT', `/weeks/${DATE}/hungryroot`, { recipes: [{ id: TIKKA.id, times: 2 }] });

    const { recipes } = (await harness.call('GET', `/weeks/${DATE}`)).body.hungryroot as { recipes: { id: string; times: number }[] };
    const resent = await harness.call('PUT', `/weeks/${DATE}/hungryroot`, {
      recipes: [...recipes.map(({ id, times }) => ({ id, times })), { id: 'tempeh-bowl-7' }],
    });

    expect(resent.body.hungryroot).toMatchObject({
      recipes: [
        { id: TIKKA.id, servings: 4, times: 2 },
        { id: 'tempeh-bowl-7', servings: 2, times: 1 },
      ],
    });
  });

  it('refuses the same recipe listed twice, since times says how often it was added', async () => {
    const { status, body } = await setup({ catalogRecipes: [TIKKA] }).call('PUT', `/weeks/${DATE}/hungryroot`, {
      recipes: [{ id: TIKKA.id }, { id: TIKKA.id }],
    });

    expect(status).toBe(400);
    expect(body.error).toBe(`List each recipe once, with times for how often it was added: ${TIKKA.id}.`);
  });

  it('refuses a recipe that is not in the catalogue, or one Hungryroot dropped, and saves nothing', async () => {
    const harness = setup({ catalogRecipes: [TIKKA, GONE] });

    const unknown = await harness.call('PUT', `/weeks/${DATE}/hungryroot`, { recipes: [{ id: TIKKA.id }, { id: 'nope-1' }] });
    const gone = await harness.call('PUT', `/weeks/${DATE}/hungryroot`, { recipes: [{ id: GONE.id }] });

    expect(unknown).toMatchObject({ status: 400, body: { error: "These aren't in the Hungryroot catalogue: nope-1." } });
    expect(gone).toMatchObject({ status: 400, body: { error: 'Hungryroot no longer offers: Recipe old-bowl-5.' } });
    expect((await harness.call('GET', `/weeks/${DATE}`)).body.hungryroot).toMatchObject({ state: 'missed', recipes: [] });
  });
});

describe('POST /api/weeks/:date/hungryroot/lock', () => {
  it('locks a confirmed box, and refuses a week with no box', async () => {
    const harness = setup({ catalogRecipes: [TIKKA] });

    expect((await harness.call('POST', `/weeks/${DATE}/hungryroot/lock`)).status).toBe(409);
    await harness.call('PUT', `/weeks/${DATE}/hungryroot`, { recipes: [{ id: TIKKA.id }] });
    const { status, body } = await harness.call('POST', `/weeks/${DATE}/hungryroot/lock`);

    expect(status).toBe(200);
    expect(body.hungryroot).toMatchObject({ state: 'locked' });
  });
});

describe('GET /api/calendar', () => {
  it("names the week to plan and the box still open, in the household's time zone", async () => {
    const harness = setup();

    expect((await harness.call('GET', '/calendar')).body).toEqual({
      today: '2026-11-10',
      plan: { id: '2026-W47', start: '2026-11-16', end: '2026-11-22' },
      box: { week: { id: '2026-W47', start: '2026-11-16', end: '2026-11-22' }, cutoff: '2026-11-12', cutoffDay: 'thursday', cutoffTime: null },
    });
  });

  it("moves the open box a week on once the coming week's cutoff has passed", async () => {
    const harness = setup();
    harness.advance(4 * 24 * 60);

    expect((await harness.call('GET', '/calendar')).body).toMatchObject({
      today: '2026-11-14',
      plan: { id: '2026-W47' },
      box: { week: { id: '2026-W48' }, cutoff: '2026-11-19' },
    });
  });
});

describe('POST /api/weeks/:date/hungryroot/suggestions/new', () => {
  it('answers with a new list for the week', async () => {
    const { status, body } = await setup({ catalogRecipes: [TIKKA] }).call('POST', `/weeks/${DATE}/hungryroot/suggestions/new`);

    expect(status).toBe(200);
    expect(body).toMatchObject({ week: { id: WEEK }, suggestions: [{ id: TIKKA.id }] });
  });
});

describe('GET /api/weeks/:date/hungryroot/suggestions', () => {
  it("answers with the week's box suggestions by catalogue id", async () => {
    const { status, body } = await setup({ catalogRecipes: [TIKKA] }).call('GET', `/weeks/${DATE}/hungryroot/suggestions`);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      week: { id: WEEK },
      boxServings: 12,
      chosenServings: 0,
      wanted: 3,
      directive: 'directives/general.md',
      rankedBy: 'protein',
      suggestions: [{ id: TIKKA.id, times: 2, servings: 4 }],
    });
  });
});

describe('marking a Hungryroot recipe not available', () => {
  it('records it with when and how often, lists it for review, and clears it', async () => {
    const harness = setup({ catalogRecipes: [TIKKA, GONE] });

    const first = await harness.call('POST', `/hungryroot/unavailable/${TIKKA.id}`, { week: '2026-11-23' });
    harness.advance(60);
    await harness.call('POST', `/hungryroot/unavailable/${TIKKA.id}`);
    await harness.call('POST', `/hungryroot/unavailable/${GONE.id}`);
    const review = await harness.call('GET', '/hungryroot/unavailable');

    expect(first).toMatchObject({ status: 200, body: { recipe: { id: TIKKA.id, title: TIKKA.title, times: 1, lastWeek: '2026-W48' } } });
    expect(review.body.recipes).toMatchObject([
      { id: TIKKA.id, times: 2, firstMarkedAt: '2026-11-10T18:00:00.000Z', lastMarkedAt: '2026-11-10T19:00:00.000Z', stillListed: true },
      { id: GONE.id, times: 1, stillListed: false },
    ]);

    await harness.call('DELETE', `/hungryroot/unavailable/${TIKKA.id}`);
    expect(((await harness.call('GET', '/hungryroot/unavailable')).body.recipes as { id: string }[]).map(({ id }) => id)).toEqual([GONE.id]);
  });

  it('refuses a recipe that is not in the catalogue', async () => {
    expect((await setup().call('POST', '/hungryroot/unavailable/nope-1')).status).toBe(400);
  });

  it('clears the mark when the recipe goes into a box, since it was available after all', async () => {
    const harness = setup({ catalogRecipes: [TIKKA] });
    await harness.call('POST', `/hungryroot/unavailable/${TIKKA.id}`);

    await harness.call('PUT', `/weeks/${DATE}/hungryroot`, { recipes: [{ id: TIKKA.id }] });

    expect([...harness.unavailable.records.keys()]).toEqual([]);
  });
});

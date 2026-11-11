import { describe, expect, it } from 'vitest';
import type { BrandedFood } from '../../src/sources/fdc.ts';
import { DATE, RESEARCH_ROUTINE, setup, WEEK } from './harness.ts';

const wegmansLemons: BrandedFood = { fdcId: 9, description: 'ORGANIC LEMONS', brand: 'WEGMANS', owner: null, ingredients: 'Organic Lemons' };
const branded = { 'Wegmans Organic Lemons': [wegmansLemons] };

interface Item {
  ingredientId: string;
  [key: string]: unknown;
}

const item = (items: unknown, id: string) => (items as Item[]).find(({ ingredientId }) => ingredientId === id);

const lemons = [
  { product_id: '501', name: 'Sunkist Lemon', size: '1 each' },
  { product_id: '502', name: 'Wegmans Organic Lemons, 2 lb', size: '2 lb' },
];

const startLookup = async (harness: ReturnType<typeof setup>) => {
  const { status, body } = await harness.call('POST', `/weeks/${DATE}/products/lookups`);
  expect(status).toBe(202);
  return (body.job as { id: string }).id;
};

describe('lookups', () => {
  it('fires the research routine for items without a product, and shows them as looking up', async () => {
    const harness = setup({ branded });

    const jobId = await startLookup(harness);

    expect(harness.fired).toEqual([
      { trigger: RESEARCH_ROUTINE, payload: { job_id: jobId, stores: ['Wegmans'], items: [{ id: 'lemon', term: 'lemon', for: 'lemon' }] } },
    ]);
    const products = (await harness.call('GET', `/weeks/${DATE}/products`)).body;
    expect(item(products.items, 'lemon')).toMatchObject({ status: 'looking-up', search: 'lemon' });
    expect(products.blockers).toEqual({ toChoose: 0, lookingUp: 1, veganQuestions: 0 });
    expect(products.lookup).toMatchObject({ id: jobId, kind: 'lookup', state: 'running', week: WEEK, progress: { done: 0, total: 1 } });
  });

  it('returns the running lookup instead of starting a second one', async () => {
    const harness = setup({ branded });
    const first = await startLookup(harness);

    expect(await startLookup(harness)).toBe(first);
    expect(harness.fired).toHaveLength(1);
  });

  it("records the routine's results vegan-checked, in the routine's order, and finishes the job", async () => {
    const harness = setup({ branded });
    const jobId = await startLookup(harness);

    const reported = await harness.report({ job_id: jobId, results: [{ id: 'lemon', store: 'Wegmans', term: 'lemon', for: 'lemon', products: lemons }] });

    expect(reported).toEqual({ status: 200, body: { job: jobId, recorded: 1, state: 'done' } });
    const products = (await harness.call('GET', `/weeks/${DATE}/products`)).body;
    expect(item(products.items, 'lemon')).toMatchObject({
      status: 'choose',
      suggestions: [
        { productId: '501', name: 'Sunkist Lemon', packages: 1, vegan: { verdict: 'needs-review' }, why: ['1 covers the need'] },
        { productId: '502', name: 'Wegmans Organic Lemons, 2 lb', vegan: { verdict: 'vegan' }, why: ['store brand'] },
      ],
    });
    expect((await harness.call('GET', `/jobs/${jobId}`)).body).toMatchObject({
      state: 'done',
      progress: { done: 1, total: 1 },
      result: { found: 1, of: 1, nothingFor: [], notSearched: [] },
    });
    expect((await harness.call('GET', '/jobs?state=running')).body).toEqual({ jobs: [] });
  });

  it('lists running jobs, and reads one the routine never answered as failed after 20 minutes', async () => {
    const harness = setup({ branded });
    const jobId = await startLookup(harness);

    expect((await harness.call('GET', '/jobs?state=running')).body).toMatchObject({ jobs: [{ id: jobId, state: 'running' }] });

    harness.advance(21);
    expect((await harness.call('GET', '/jobs?state=running')).body).toEqual({ jobs: [] });
    expect((await harness.call('GET', `/jobs/${jobId}`)).body).toMatchObject({ state: 'failed', error: expect.stringMatching(/20 minutes/) });
    expect(item((await harness.call('GET', `/weeks/${DATE}/products`)).body.items, 'lemon')).toMatchObject({ status: 'choose' });
    expect((await harness.report({ job_id: jobId, done: true })).status).toBe(409);
  });

  it('keeps an error the routine reports', async () => {
    const harness = setup({ branded });
    const jobId = await startLookup(harness);

    await harness.report({ job_id: jobId, error: 'The Instacart connector is missing.', done: true });

    expect((await harness.call('GET', `/jobs/${jobId}`)).body).toMatchObject({
      state: 'failed',
      error: 'The Instacart connector is missing.',
      result: { notSearched: [{ ingredientId: 'lemon', ingredient: 'lemon' }] },
    });
  });

  it('refuses results without the routine secret, or for a job that does not exist', async () => {
    const harness = setup({ branded });
    const jobId = await startLookup(harness);

    expect((await harness.report({ job_id: jobId, done: true }, 'wrong')).status).toBe(401);
    expect((await harness.report({ job_id: 'h1.0b8f1c2e-1111-4222-8333-944455556666', done: true })).status).toBe(404);
    expect((await harness.report({ job_id: 'nonsense', done: true })).status).toBe(404);
  });

  it('refuses a lookup when every item has a product, or when lookups are not set up', async () => {
    const harness = setup({ branded });
    await harness.call('PUT', `/weeks/${DATE}/products/lemon`, { productId: '222', name: 'Lemons' });

    expect((await harness.call('POST', `/weeks/${DATE}/products/lookups`)).status).toBe(409);
    expect((await setup({ researchRoutine: null }).call('POST', `/weeks/${DATE}/products/lookups`)).status).toBe(503);
  });
});

describe('searches', () => {
  it("searches the store for one item with the household's own words, and shows the results on the item", async () => {
    const harness = setup({ branded });

    const { status, body } = await harness.call('POST', `/weeks/${DATE}/products/lemon/searches`, { query: 'organic lemons' });

    expect(status).toBe(202);
    const jobId = (body.job as { id: string }).id;
    expect(harness.fired[0]?.payload).toEqual({ job_id: jobId, stores: ['Wegmans'], items: [{ id: 'lemon', term: 'organic lemons', for: 'lemon' }] });

    await harness.report({ job_id: jobId, results: [{ id: 'lemon', store: 'Wegmans', term: 'organic lemons', for: 'lemon', products: lemons.slice(1) }], done: true });

    expect((await harness.call('GET', `/jobs/${jobId}`)).body).toMatchObject({
      kind: 'search',
      result: { ingredientId: 'lemon', suggestions: [{ productId: '502' }], excluded: [] },
    });
    expect(item((await harness.call('GET', `/weeks/${DATE}/products`)).body.items, 'lemon')).toMatchObject({ suggestions: [{ productId: '502' }] });
  });

  it('turns away an item not on the list, and a query too short to search', async () => {
    const harness = setup({ branded });

    expect((await harness.call('POST', `/weeks/${DATE}/products/capers/searches`, { query: 'capers' })).status).toBe(404);
    expect((await harness.call('POST', `/weeks/${DATE}/products/lemon/searches`, { query: 'a' })).status).toBe(400);
  });
});

describe('GET /api/jobs', () => {
  it('only lists running jobs, and finds no job that is not there', async () => {
    const harness = setup();

    expect((await harness.call('GET', '/jobs')).status).toBe(400);
    expect((await harness.call('GET', '/jobs/h1.0b8f1c2e-1111-4222-8333-944455556666')).status).toBe(404);
  });
});

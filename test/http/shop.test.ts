import { describe, expect, it } from 'vitest';
import type { BrandedFood } from '../../src/sources/fdc.ts';
import { DATE, setup, WEEK } from './harness.ts';

interface Row {
  ingredientId: string;
  [key: string]: unknown;
}

const row = (rows: unknown, id: string) => (rows as Row[]).find(({ ingredientId }) => ingredientId === id);

describe('GET /api/weeks/:date', () => {
  it("shows the week's meals and where shopping stands", async () => {
    const { call } = setup();

    const { status, body } = await call('GET', `/weeks/${DATE}`);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      week: { id: WEEK, start: '2026-11-09', end: '2026-11-15' },
      saved: true,
      meals: [{ recipeId: 'r1', title: 'Tofu Scramble', servings: 2, slot: 'dinner' }],
      shop: { state: 'list' },
    });
  });

  it('shows an unsaved week as empty', async () => {
    const { call } = setup({ planned: false });

    expect((await call('GET', `/weeks/${DATE}`)).body).toMatchObject({ saved: false, meals: [], shop: { state: 'not-saved' } });
  });

  it('turns away a date that is not one', async () => {
    const { call } = setup();

    expect((await call('GET', '/weeks/next-week')).status).toBe(400);
  });
});

describe('the list', () => {
  it('lists what to buy, with packs, first-time items and staples, without asking Claude for parsed lines', async () => {
    const { call, prompts } = setup();

    const { status, body } = await call('GET', `/weeks/${DATE}/list`);

    expect(status).toBe(200);
    expect(row(body.buy, 'extra-firm-tofu')).toMatchObject({
      ingredient: 'extra-firm tofu',
      need: { text: '28 oz', amount: 28, unit: 'oz' },
      firstTime: false,
      someAllowed: true,
      have: { state: 'none' },
      pack: { product: 'Organic Extra Firm Tofu', size: '14 oz', toBuy: 2 },
    });
    expect(row(body.buy, 'lemon')).toMatchObject({ firstTime: true, someAllowed: false });
    expect(body.staples).toEqual([{ ingredientId: 'salt', ingredient: 'salt', thisWeek: '1 tsp', out: false }]);
    expect(prompts).toEqual([]);
  });

  it('is not found for a week with nothing planned', async () => {
    const { call } = setup({ planned: false });

    expect((await call('GET', `/weeks/${DATE}/list`)).status).toBe(404);
  });

  it('takes packs on hand off what to buy, and returns the whole list', async () => {
    const { call, weeks } = setup();

    const { status, body } = await call('PUT', `/weeks/${DATE}/list/have`, { ingredientId: 'extra-firm-tofu', state: 'some', amount: 1, unit: 'pack' });

    expect(status).toBe(200);
    expect(row(body.buy, 'extra-firm-tofu')).toMatchObject({ have: { state: 'some', amount: 1, unit: 'pack' }, pack: { toBuy: 1 } });
    expect(weeks.docs.get(WEEK)?.have).toEqual({ 'extra-firm tofu': { amount: 1, unit: 'pack' } });
  });

  it('moves an item to have, and back again', async () => {
    const { call, weeks } = setup();

    const all = await call('PUT', `/weeks/${DATE}/list/have`, { ingredientId: 'lemon', state: 'all' });
    expect(row(all.body.have, 'lemon')).toMatchObject({ have: { state: 'all' } });
    expect(row(all.body.buy, 'lemon')).toBeUndefined();

    const none = await call('PUT', `/weeks/${DATE}/list/have`, { ingredientId: 'lemon', state: 'none' });
    expect(row(none.body.buy, 'lemon')).toBeDefined();
    expect(weeks.docs.get(WEEK)?.have).toEqual({});
  });

  it('asks for an amount with "some", and turns away an item not on the list', async () => {
    const { call } = setup();

    expect((await call('PUT', `/weeks/${DATE}/list/have`, { ingredientId: 'extra-firm-tofu', state: 'some' })).status).toBe(400);
    expect((await call('PUT', `/weeks/${DATE}/list/have`, { ingredientId: 'capers', state: 'all' })).status).toBe(404);
  });

  it('puts a staple that ran out on the buy list', async () => {
    const { call } = setup();

    const out = await call('PUT', `/weeks/${DATE}/list/staples`, { ingredientId: 'salt', out: true });
    expect(out.body.staples).toEqual([]);
    expect(row(out.body.buy, 'salt')).toMatchObject({ runningLow: true });

    const back = await call('PUT', `/weeks/${DATE}/list/staples`, { ingredientId: 'salt', out: false });
    expect(row(back.body.staples, 'salt')).toBeDefined();
  });

  it('keeps a first-time ingredient stocked, as a decision', async () => {
    const { call, ingredients, decisions } = setup();

    const { status, body } = await call('PUT', '/ingredients/lemon/buying', { buying: 'stocked' });

    expect(status).toBe(200);
    expect(body).toEqual({ ingredientId: 'lemon', ingredient: 'lemon', buying: 'stocked' });
    expect([...ingredients.stored.values()].find(({ name }) => name === 'lemon')?.buying).toBe('staple');
    expect(decisions.recorded).toEqual([
      { kind: 'ingredient-buying', input: ['lemon'], suggestion: { lemon: null }, answer: { buying: 'staple', comesWith: null }, by: 'uid1' },
    ]);
    expect((await call('PUT', '/ingredients/capers/buying', { buying: 'never' })).status).toBe(404);
  });
});

describe('products', () => {
  it("shows each item's product and what still blocks approval", async () => {
    const { call } = setup();

    const { status, body } = await call('GET', `/weeks/${DATE}/products`);

    expect(status).toBe(200);
    expect(body).toMatchObject({ retailer: 'Wegmans', blockers: { toChoose: 1, veganQuestions: 0 } });
    expect(row(body.items, 'extra-firm-tofu')).toMatchObject({ status: 'ready', pick: { productId: '111', packages: 2, vegan: { verdict: 'vegan' } } });
    expect(row(body.items, 'lemon')).toMatchObject({ status: 'choose', search: 'lemon', suggestions: [] });
    expect(body.listHash).toBe((await call('GET', `/weeks/${DATE}/list`)).body.listHash);
  });

  it('offers the alternatives on an item that already has a product, so it can be changed', async () => {
    const { call } = setup();
    await call('PUT', `/weeks/${DATE}/products/lemon`, { productId: '222', name: 'Lemons', size: '1 each' });

    const changed = await call('PUT', `/weeks/${DATE}/products/lemon`, { productId: '444', name: 'Organic Lemons', size: '1 each' });

    expect(row(changed.body.items, 'lemon')).toMatchObject({
      status: 'ready',
      pick: { productId: '444' },
      suggestions: [{ productId: '222', name: 'Lemons', why: ['your alternate'] }],
      search: 'lemon',
    });
    expect(row(changed.body.items, 'extra-firm-tofu')).toMatchObject({ status: 'ready', suggestions: [], search: 'extra-firm tofu' });
  });

  it('takes a product with no ingredient list as ready, noting it unlabelled rather than asking', async () => {
    const { call } = setup();

    const chosen = await call('PUT', `/weeks/${DATE}/products/lemon`, { productId: '222', name: 'Lemons', size: '1 each' });

    expect(chosen.status).toBe(200);
    expect(row(chosen.body.items, 'lemon')).toMatchObject({ status: 'ready', pick: { productId: '222', name: 'Lemons', vegan: { verdict: 'unlabelled' } } });
    expect(chosen.body.blockers).toEqual({ toChoose: 0, lookingUp: 0, veganQuestions: 0, notVegan: 0 });
  });

  it('keeps a real vegan question open without holding up approval, and settles it when answered', async () => {
    const { call } = setup({ branded: { 'Simply Lemonade': [lemonade] } });

    const chosen = await call('PUT', `/weeks/${DATE}/products/lemon`, { productId: '333', name: 'Simply Lemonade', size: '52 fl oz' });
    expect(row(chosen.body.items, 'lemon')).toMatchObject({ status: 'vegan-question', pick: { vegan: { verdict: 'needs-review' } } });
    expect(chosen.body.blockers).toMatchObject({ veganQuestions: 1, notVegan: 0 });
    expect((await call('POST', `/weeks/${DATE}/instacart/approve`, { listHash: chosen.body.listHash, quantities: { lemon: 1 } })).status).toBe(200);

    const reviewed = await call('PUT', `/weeks/${DATE}/products/vegan/333`, { name: 'Simply Lemonade', vegan: true });
    expect(row(reviewed.body.items, 'lemon')).toMatchObject({ status: 'ready' });
  });

  it('holds up approval only for a product judged not vegan, until another is chosen', async () => {
    const { call } = setup();
    await call('PUT', `/weeks/${DATE}/products/lemon`, { productId: '222', name: 'Lemons', size: '1 each' });

    const answered = await call('PUT', `/weeks/${DATE}/products/vegan/222`, { name: 'Lemons', vegan: false });
    expect(row(answered.body.items, 'lemon')).toMatchObject({ status: 'not-vegan' });
    expect(answered.body.blockers).toMatchObject({ notVegan: 1 });
    const refused = await call('POST', `/weeks/${DATE}/instacart/approve`, { listHash: answered.body.listHash });
    expect(refused).toEqual({ status: 409, body: { error: 'These products are judged not vegan; choose others first: lemon (Lemons).' } });

    const swapped = await call('PUT', `/weeks/${DATE}/products/lemon`, { productId: '444', name: 'Organic Lemons', size: '1 each' });
    expect((await call('POST', `/weeks/${DATE}/instacart/approve`, { listHash: swapped.body.listHash })).status).toBe(200);
  });

  it("counts packages from what one covers, when the size doesn't say", async () => {
    const { call } = setup();

    const bySize = await call('PUT', `/weeks/${DATE}/products/lemon`, { productId: '333', name: 'Lemons, Bagged', size: '2 lb' });
    expect(row(bySize.body.items, 'lemon')).toMatchObject({ pick: { packages: null } });

    const byCount = await call('PUT', `/weeks/${DATE}/products/lemon`, { productId: '333', name: 'Lemons, Bagged', size: '2 lb', covers: 6 });
    expect(row(byCount.body.items, 'lemon')).toMatchObject({ pick: { packages: 1 } });
    expect((await call('PUT', `/weeks/${DATE}/products/lemon`, { productId: '333', name: 'Lemons, Bagged', covers: 0 })).status).toBe(400);
  });

  it('turns down a product for an ingredient', async () => {
    const { call, products } = setup();

    const { status } = await call('POST', `/weeks/${DATE}/products/extra-firm-tofu/rejections`, { productId: '333', reason: 'silken' });

    expect(status).toBe(200);
    expect(products.stored.get('instacart_333_extra-firm-tofu')).toMatchObject({ role: 'rejected', reason: 'silken' });
  });

  it("explains a product's vegan verdict", async () => {
    const { call } = setup();

    expect((await call('GET', '/products/111/vegan')).body).toMatchObject({ productId: '111', name: 'Organic Extra Firm Tofu', verdict: 'vegan' });
    expect((await call('GET', '/products/999/vegan')).status).toBe(404);
    expect((await call('GET', '/products/abc/vegan')).status).toBe(400);
  });
});

const lemonade: BrandedFood = { fdcId: 8, description: 'LEMONADE', brand: 'SIMPLY', owner: null, ingredients: 'Water, Cane Sugar, Lemon Juice, Natural Flavors' };
const lemonCurd: BrandedFood = { fdcId: 7, description: 'LEMON CURD', brand: 'BONNE MAMAN', owner: null, ingredients: 'Sugar, Butter, Lemon Juice, Eggs' };

describe('PUT /api/weeks/:date/products', () => {
  const curd = { productId: '777', name: 'Bonne Maman Lemon Curd' };

  it('saves vegan answers before choices, so one save can answer a question and choose that product', async () => {
    const { call } = setup({ branded: { 'Bonne Maman Lemon Curd': [lemonCurd] } });

    const { status, body } = await call('PUT', `/weeks/${DATE}/products`, {
      choices: [{ ingredientId: 'lemon', ...curd, size: '11.25 oz', covers: 4 }],
      veganAnswers: [{ ...curd, vegan: true }],
    });

    expect(status).toBe(200);
    expect(body.failed).toEqual([]);
    expect(row(body.items, 'lemon')).toMatchObject({ status: 'ready', pick: { productId: '777', packages: 1, vegan: { verdict: 'vegan' } } });
    expect(body.listHash).toBe((await call('GET', `/weeks/${DATE}/products`)).body.listHash);
  });

  it('saves what it can and names each change it could not, in plain words', async () => {
    const { call } = setup({ branded: { 'Bonne Maman Lemon Curd': [lemonCurd] } });

    const { status, body } = await call('PUT', `/weeks/${DATE}/products`, {
      choices: [
        { ingredientId: 'lemon', ...curd },
        { ingredientId: 'capers', productId: '888', name: 'Capers' },
      ],
    });

    expect(status).toBe(200);
    expect(body.failed).toEqual([
      { ingredientId: 'capers', productId: '888', error: '"capers" isn\'t on this week\'s list.' },
      { ingredientId: 'lemon', productId: '777', error: expect.stringMatching(/^Bonne Maman Lemon Curd looks non-vegan/) },
    ]);
    expect(row(body.items, 'lemon')).toMatchObject({ status: 'choose' });
  });

  it('turns away an empty save, or a malformed change', async () => {
    const { call } = setup();

    expect((await call('PUT', `/weeks/${DATE}/products`, {})).status).toBe(400);
    expect((await call('PUT', `/weeks/${DATE}/products`, { veganAnswers: [{ productId: 'abc', name: 'x', vegan: true }] })).status).toBe(400);
  });
});

describe('the Instacart cart', () => {
  it('approves the list it was shown, leaving out items without a product', async () => {
    const { call } = setup();
    const { listHash } = (await call('GET', `/weeks/${DATE}/products`)).body;

    const { status, body } = await call('POST', `/weeks/${DATE}/instacart/approve`, { listHash });

    expect(status).toBe(200);
    expect(body).toEqual({
      week: { id: WEEK, start: '2026-11-09', end: '2026-11-15' },
      lines: [{ ingredientId: 'extra-firm-tofu', ingredient: 'extra-firm tofu', productId: '111', product: 'Organic Extra Firm Tofu', quantity: 2 }],
      notInCart: [{ ingredientId: 'lemon', ingredient: 'lemon' }],
    });
    expect((await call('GET', `/weeks/${DATE}/instacart`)).body).toMatchObject({ state: 'approved', approved: { lines: 1 }, listChanged: false });
  });

  it('refuses a list that changed since it was shown', async () => {
    const { call } = setup();

    expect((await call('POST', `/weeks/${DATE}/instacart/approve`, { listHash: 'stale' })).status).toBe(409);
  });

  it('notices when the list changes after approval', async () => {
    const { call } = setup();
    const { listHash } = (await call('GET', `/weeks/${DATE}/products`)).body;
    await call('POST', `/weeks/${DATE}/instacart/approve`, { listHash });

    await call('PUT', `/weeks/${DATE}/list/have`, { ingredientId: 'extra-firm-tofu', state: 'some', amount: 1, unit: 'pack' });

    expect((await call('GET', `/weeks/${DATE}/instacart`)).body).toMatchObject({ state: 'approved', listChanged: true });
  });

  it('records the checkout', async () => {
    const { call } = setup();
    const { listHash } = (await call('GET', `/weeks/${DATE}/products`)).body;
    await call('POST', `/weeks/${DATE}/instacart/approve`, { listHash });

    const { status, body } = await call('POST', `/weeks/${DATE}/instacart/checked-out`);

    expect(status).toBe(200);
    expect(body).toMatchObject({ state: 'checked-out', checkedOut: true });
  });
});

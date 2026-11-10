import { describe, expect, it } from 'vitest';
import { cartLines, compareCart, listHash, matchItem } from '../../src/core/instacart-match.ts';
import type { ListItem } from '../../src/core/shopping-list.ts';
import { blankMemory, type RememberedProduct } from '../../src/data/product-memory.ts';
import { entry } from '../fakes.ts';

const item = (ingredient: string, overrides: Partial<ListItem> = {}): ListItem => ({ ingredient, need: null, uses: [], ...overrides });

const remembered = (productId: string, ingredient: string | null, overrides: Partial<RememberedProduct> = {}): RememberedProduct => ({
  ...blankMemory(productId, 'uid1', ingredient),
  ...overrides,
});

const tofu = item('extra-firm tofu', { need: '30 oz', amount: { value: 30, unit: 'oz' } });

describe('matchItem', () => {
  it("uses the household's usual product with its package count and vegan check, and lists its alternates", () => {
    const memory = [
      remembered('18165406', 'extra-firm tofu', { role: 'preferred', name: 'Wegmans Organic Extra Firm Tofu', size: '14 oz' }),
      remembered('47672', 'extra-firm tofu', { role: 'alternate', name: 'Nasoya Extra Firm Organic Tofu', size: '14 oz' }),
      remembered('18165406', null, { check: { verdict: 'vegan', reasons: ['no animal ingredients in its list'], label: null } }),
    ];

    const matched = matchItem(tofu, memory, entry('extra-firm tofu'));

    expect(matched).toMatchObject({
      status: 'chosen',
      search: null,
      pick: { productId: '18165406', name: 'Wegmans Organic Extra Firm Tofu', packages: 2, vegan: { verdict: 'vegan' }, source: 'your choice' },
    });
    expect(matched.alternates).toEqual([expect.objectContaining({ productId: '47672', vegan: { verdict: 'unchecked', reasons: expect.any(Array) } })]);
  });

  it("prefers the household's vegan review over the automatic check", () => {
    const memory = [
      remembered('3287524', 'tomato', { role: 'preferred', name: 'Beefsteak Tomatoes' }),
      remembered('3287524', null, {
        vegan: { vegan: true, concerns: [], ingredientsHash: 'x', by: 'uid1' },
        check: { verdict: 'needs-review', reasons: ['no ingredient list found for it in FoodData Central'], label: null },
      }),
    ];

    expect(matchItem(item('tomato'), memory, undefined).pick?.vegan).toEqual({ verdict: 'vegan', reasons: ['your review'] });
  });

  it('gives an item without a chosen product a search term, the taught one first, and the products rejected for it', () => {
    const memory = [remembered('279945', 'butter beans', { role: 'rejected', reason: 'seasoned with pork' })];

    expect(matchItem(item('butter beans'), memory, entry('butter beans', { storeSearch: 'butter beans canned' }))).toMatchObject({
      status: 'choose',
      pick: null,
      search: 'butter beans canned',
      rejected: ['279945'],
    });
    expect(matchItem(item('garlic'), [], undefined).search).toBe('garlic');
  });
});

describe('cartLines', () => {
  const memory = [
    remembered('18165406', 'extra-firm tofu', { role: 'preferred', name: 'Wegmans Organic Extra Firm Tofu', size: '14 oz' }),
    remembered('3293710', 'lettuce', { role: 'preferred', name: 'Iceberg Lettuce' }),
  ];
  const items = [tofu, item('lettuce', { need: '2 cup' }), item('dill')].map((listed) => matchItem(listed, memory, undefined));

  it('adds each chosen product at its package count, and lists what has no product or no count', () => {
    expect(cartLines(items)).toEqual({
      lines: [{ ingredient: 'extra-firm tofu', productId: '18165406', quantity: 2, name: 'Wegmans Organic Extra Firm Tofu' }],
      notInCart: ['dill'],
      needQuantity: ['lettuce'],
    });
  });

  it("takes the household's quantity where given", () => {
    expect(cartLines(items, { lettuce: 1, 'extra-firm tofu': 3 }).lines.map(({ quantity }) => quantity)).toEqual([3, 1]);
  });
});

describe('listHash', () => {
  it('changes with the list, not its order', () => {
    const a = item('tofu', { need: '2 block' });
    const b = item('garlic', { need: '5 clove' });

    expect(listHash([a, b])).toBe(listHash([b, a]));
    expect(listHash([a])).not.toBe(listHash([{ ...a, need: '3 block' }]));
  });
});

describe('compareCart', () => {
  const approved = [
    { ingredient: 'extra-firm tofu', productId: '18165406', quantity: 2, name: 'Wegmans Organic Extra Firm Tofu' },
    { ingredient: 'firm tofu', productId: '18165406', quantity: 1, name: 'Wegmans Organic Extra Firm Tofu' },
    { ingredient: 'dill', productId: '3259165', quantity: 1, name: 'Fresh Dill' },
  ];

  it('matches a cart holding every approved product at its combined quantity', () => {
    const cart = [
      { productId: '18165406', quantity: 3, name: null },
      { productId: '3259165', quantity: 1, name: null },
    ];

    expect(compareCart(approved, cart)).toEqual({ matches: true, missing: [], differs: [], extra: [] });
  });

  it("reports what's missing, what has another quantity, and anything extra", () => {
    const cart = [
      { productId: '18165406', quantity: 2, name: null },
      { productId: '999', quantity: 1, name: 'Cucumber' },
    ];

    expect(compareCart(approved, cart)).toEqual({
      matches: false,
      missing: [{ productId: '3259165', quantity: 1, for: ['Fresh Dill'] }],
      differs: [{ productId: '18165406', wanted: 3, inCart: 2, for: ['Wegmans Organic Extra Firm Tofu', 'Wegmans Organic Extra Firm Tofu'] }],
      extra: [{ productId: '999', quantity: 1, name: 'Cucumber' }],
    });
  });
});

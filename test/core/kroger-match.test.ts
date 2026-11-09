import { describe, expect, it } from 'vitest';
import { matchItem } from '../../src/core/kroger-match.ts';
import type { ListItem } from '../../src/core/shopping-list.ts';
import { blankMemory, type RememberedProduct } from '../../src/data/product-memory.ts';
import type { KrogerProduct } from '../../src/sources/kroger.ts';
import { entry } from '../fakes.ts';

const product = (upc: string, overrides: Partial<KrogerProduct> = {}): KrogerProduct => ({
  upc,
  brand: 'Simple Truth Organic',
  description: `Tofu ${upc}`,
  size: '14 oz',
  price: 1.99,
  salePrice: null,
  stock: 'HIGH',
  aisle: 'DAIRY',
  declaredVegan: true,
  allergens: [],
  link: null,
  label: { ingredients: 'Water, Soybeans', categories: [], declarations: ['Vegan'], contains: [], mayContain: [] },
  ...overrides,
});

const remembered = (upc: string, role: RememberedProduct['role']): RememberedProduct => ({
  ...blankMemory(upc, 'uid1'),
  ingredient: 'extra-firm tofu',
  role,
});

const item: ListItem = {
  ingredient: 'extra-firm tofu',
  need: '3 block',
  uses: ['Curry: 3 block (14 oz each)'],
  amount: { value: 3, unit: 'block', eachGrams: 396.893 },
};

const match = (memory: RememberedProduct[], shelf: KrogerProduct[], found: KrogerProduct[] = []) =>
  matchItem(item, {
    entry: entry('extra-firm tofu'),
    memory,
    remembered: new Map(shelf.map((each) => [each.upc, each])),
    found,
    tallies: new Map(),
  });

describe('matchItem', () => {
  it("picks the household's usual product when it's in stock, with its package count and vegan verdict", () => {
    const matched = match([remembered('0001', 'preferred')], [product('0001')]);

    expect(matched.pick).toMatchObject({ upc: '0001', source: 'your choice', packages: 3, vegan: { verdict: 'vegan' } });
    expect(matched.candidates).toEqual([]);
  });

  it("falls back to a remembered alternate when the usual one is out of stock, and says so", () => {
    const matched = match(
      [remembered('0001', 'preferred'), remembered('0002', 'alternate')],
      [product('0001', { stock: 'TEMPORARILY_OUT_OF_STOCK' }), product('0002')],
    );

    expect(matched.pick).toMatchObject({ upc: '0002', source: 'your alternate' });
    expect(matched.notes).toEqual(['Your usual product (0001) is out of stock.']);
  });

  it('offers search results without the products the household rejected', () => {
    const matched = match([remembered('0009', 'rejected')], [], [product('0009'), product('0003')]);

    expect(matched.pick).toBeNull();
    expect(matched.candidates.map(({ upc }) => upc)).toEqual(['0003']);
  });

  it('names a gap when the store has nothing', () => {
    expect(match([], []).notes).toEqual(['Nothing found at this store: a gap for Whole Foods or an online order.']);
  });

  it("says when the usual product isn't sold at the store any more", () => {
    expect(match([remembered('0001', 'preferred')], [], [product('0003')]).notes).toEqual([
      "Your usual product (0001) isn't sold at this store now.",
    ]);
  });
});

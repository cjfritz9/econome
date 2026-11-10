import { describe, expect, it } from 'vitest';
import { matchItem } from '../../src/core/kroger-match.ts';
import type { ListItem } from '../../src/core/shopping-list.ts';
import { blankMemory, RememberedProductSchema, rememberedId, type RememberedProduct } from '../../src/data/product-memory.ts';
import type { KrogerProduct } from '../../src/sources/kroger.ts';
import { ingredientsHash } from '../../src/core/vegan.ts';
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

    expect(matched).toMatchObject({ status: 'choose', pick: null });
    expect(matched.candidates.map(({ upc }) => upc)).toEqual(['0003']);
  });

  it('counts packages by what the household said one covers', () => {
    const bunch: RememberedProduct = { ...remembered('0005', 'preferred'), covers: 7 };
    const onions = { ...item, ingredient: 'extra-firm tofu', amount: { value: 2.83, unit: 'piece' as const } };
    const matched = matchItem(onions, {
      entry: entry('extra-firm tofu'),
      memory: [bunch],
      remembered: new Map([['0005', product('0005', { size: '1 each' })]]),
      found: [],
      tallies: new Map(),
    });

    expect(matched.pick?.packages).toBe(1);
  });

  it("uses the household's vegan review of a product, kept apart from its ingredient choices", () => {
    const flagged = product('0007', { label: { ingredients: 'Water, Natural Flavors', categories: [], declarations: [], contains: [], mayContain: [] } });
    const review: RememberedProduct = {
      ...blankMemory('0007', 'uid1'),
      vegan: { vegan: true, concerns: ['natural flavors'], ingredientsHash: ingredientsHash('Water, Natural Flavors'), by: 'uid1' },
    };

    expect(match([review], [], [flagged]).candidates[0]?.vegan).toEqual({ verdict: 'vegan', reasons: ['you reviewed this product'] });
  });

  it('names a gap when the store has nothing', () => {
    const gap = match([], []);

    expect(gap.status).toBe('gap');
    expect(gap.notes).toEqual(['Nothing found at this store: it falls back to Whole Foods.']);
  });

  it("says when the usual product isn't sold at the store any more", () => {
    const matched = match([remembered('0001', 'preferred')], [], [product('0003')]);

    expect(matched.status).toBe('unavailable');
    expect(matched.notes).toEqual(["Your usual product (0001) isn't sold at this store now."]);
  });
});

describe('rememberedId', () => {
  it('keeps a product apart for each ingredient, and its vegan review apart from both', () => {
    expect(rememberedId('kroger', '0001115227641', 'furikake')).toBe('kroger_0001115227641_furikake');
    expect(rememberedId('kroger', '0001115227641', 'nori')).toBe('kroger_0001115227641_nori');
    expect(rememberedId('kroger', '0001115227641')).toBe('kroger_0001115227641');
  });
});

describe('RememberedProductSchema', () => {
  it('reads records saved with the old upc field as Kroger product ids', () => {
    const legacy = { store: 'kroger', upc: '0001111091342', ingredient: 'tofu', role: 'preferred', reason: null, decidedBy: 'uid1', vegan: null };

    expect(RememberedProductSchema.parse(legacy)).toMatchObject({ productId: '0001111091342', covers: null });
  });
});

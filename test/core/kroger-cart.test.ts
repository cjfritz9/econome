import { describe, expect, it } from 'vitest';
import { cartLines, linesToSend, listHash } from '../../src/core/kroger-cart.ts';
import type { MatchedItem, ProductView } from '../../src/core/kroger-match.ts';
import { emptyKrogerSection, type KrogerSection } from '../../src/data/weeks.ts';

const view = (upc: string, packages: number | null): ProductView & { source: 'your choice' } => ({
  upc,
  description: upc,
  brand: null,
  size: null,
  price: 1,
  salePrice: null,
  stock: 'HIGH',
  aisle: null,
  link: null,
  vegan: { verdict: 'vegan', reasons: [] },
  packages,
  source: 'your choice',
});

const item = (ingredient: string, pick: MatchedItem['pick'], candidates: MatchedItem['candidates'] = []): MatchedItem => ({
  ingredient,
  need: '1 piece',
  pick,
  candidates,
  notes: [],
});

describe('cartLines', () => {
  it('takes each chosen product with its package count, leaving out what has no choice or no product', () => {
    const { lines, notInCart, needQuantity } = cartLines([
      item('tofu', view('0001', 3)),
      item('furikake', null, [view('0002', 1)]),
      item('nori', null),
      item('garlic', view('0003', null)),
    ]);

    expect(lines).toEqual([{ ingredient: 'tofu', upc: '0001', quantity: 3 }]);
    expect(notInCart).toEqual([
      { ingredient: 'furikake', why: 'no product chosen, or the usual one is out of stock' },
      { ingredient: 'nori', why: 'not sold at this store' },
    ]);
    expect(needQuantity).toEqual(['garlic']);
  });

  it("uses the household's quantity over the count", () => {
    expect(cartLines([item('garlic', view('0003', null))], { garlic: 1 }).lines).toEqual([{ ingredient: 'garlic', upc: '0003', quantity: 1 }]);
  });
});

describe('linesToSend', () => {
  const section = (journal: KrogerSection['journal']): KrogerSection => ({
    ...emptyKrogerSection(),
    approved: {
      lines: [
        { ingredient: 'a', upc: '0001', quantity: 1 },
        { ingredient: 'b', upc: '0002', quantity: 1 },
        { ingredient: 'c', upc: '0003', quantity: 1 },
        { ingredient: 'd', upc: '0004', quantity: 1 },
      ],
      listHash: 'x',
      by: 'uid1',
    },
    journal,
  });
  const journal: KrogerSection['journal'] = {
    '0001': { quantity: 1, status: 'sent', message: null },
    '0002': { quantity: 1, status: 'unknown', message: 'timeout' },
    '0003': { quantity: 1, status: 'failed', message: 'refused' },
  };

  it('never sends a line twice, retries refused ones, and resends unknown ones only when asked', () => {
    expect(linesToSend(section(journal)).map(({ upc }) => upc)).toEqual(['0003', '0004']);
    expect(linesToSend(section(journal), ['0002']).map(({ upc }) => upc)).toEqual(['0002', '0003', '0004']);
  });

  it('sends nothing without an approval', () => {
    expect(linesToSend(emptyKrogerSection())).toEqual([]);
  });
});

describe('listHash', () => {
  it('changes when the list changes, whatever its order', () => {
    const list = [
      { ingredient: 'tofu', need: '3 block' },
      { ingredient: 'lime', need: '2 piece' },
    ];

    expect(listHash(list)).toBe(listHash([...list].reverse()));
    expect(listHash(list)).not.toBe(listHash([{ ingredient: 'tofu', need: '4 block' }, list[1]!]));
  });
});

import { describe, expect, it } from 'vitest';
import { jobHousehold, newJobId, rankFound, researchRequest, SUGGESTIONS_KEPT } from '../../src/core/lookups.ts';
import type { ListItem } from '../../src/core/shopping-list.ts';

const vegan = { verdict: 'vegan' as const, reasons: ['no animal ingredients in its list'] };
const unsure = { verdict: 'needs-review' as const, reasons: ['no ingredient list found for it in FoodData Central'] };
const notVegan = { verdict: 'non-vegan' as const, reasons: ['contains milk'] };

const tofu: ListItem = { ingredient: 'extra-firm tofu', need: '28 oz', amount: { value: 28, unit: 'oz' }, uses: [] };

describe('job ids', () => {
  it('carry the household, so a routine result finds its job', () => {
    const id = newJobId('h1');

    expect(jobHousehold(id)).toBe('h1');
    expect(jobHousehold('h1.not-a-uuid')).toBeNull();
    expect(jobHousehold('../h1.0b8f1c2e-1111-4222-8333-944455556666')).toBeNull();
  });
});

describe('researchRequest', () => {
  it("asks the routine to search the household's store, echoing each item's id", () => {
    expect(researchRequest('h1.job', 'Wegmans', [{ ingredientId: 'extra-firm-tofu', ingredient: 'extra-firm tofu', term: 'extra firm tofu' }])).toEqual({
      job_id: 'h1.job',
      stores: ['Wegmans'],
      items: [{ id: 'extra-firm-tofu', term: 'extra firm tofu', for: 'extra-firm tofu' }],
    });
  });
});

describe('rankFound', () => {
  const context = { item: tofu, entry: undefined, retailer: 'Wegmans', rejected: new Set<string>() };

  it('puts vegan products first, keeps the routine order otherwise, and says why each fits', () => {
    const found = rankFound(
      [
        { productId: '1', name: 'Hodo Organic Extra Firm Tofu', size: '16 oz', vegan: unsure },
        { productId: '2', name: 'Wegmans Organic Extra Firm Tofu', size: '14 oz', vegan },
        { productId: '3', name: 'Nasoya Extra Firm Tofu', size: '28 oz', vegan },
      ],
      context,
    );

    expect(found.suggestions.map(({ productId, why, packages }) => ({ productId, why, packages }))).toEqual([
      { productId: '2', why: ['store brand', '2 cover the need'], packages: 2 },
      { productId: '3', why: ['1 covers the need'], packages: 1 },
      { productId: '1', why: ['2 cover the need'], packages: 2 },
    ]);
    expect(found.excluded).toEqual([]);
  });

  it('leaves out non-vegan and turned-down products, saying why, never silently', () => {
    const found = rankFound(
      [
        { productId: '1', name: 'Tofu Pudding with Milk', size: null, vegan: notVegan },
        { productId: '2', name: 'Silken Tofu', size: '12 oz', vegan },
        { productId: '3', name: 'Firm Tofu', size: '14 oz', vegan },
      ],
      { ...context, rejected: new Set(['2']) },
    );

    expect(found.suggestions.map(({ productId }) => productId)).toEqual(['3']);
    expect(found.excluded).toEqual([
      { productId: '1', name: 'Tofu Pudding with Milk', reason: 'looks non-vegan: contains milk' },
      { productId: '2', name: 'Silken Tofu', reason: 'you turned it down for this' },
    ]);
  });

  it(`keeps the top ${SUGGESTIONS_KEPT} and lists the rest as excluded`, () => {
    const many = Array.from({ length: SUGGESTIONS_KEPT + 2 }, (_, index) => ({ productId: String(index), name: `Tofu ${index}`, size: null, vegan }));

    const found = rankFound(many, context);

    expect(found.suggestions).toHaveLength(SUGGESTIONS_KEPT);
    expect(found.excluded.map(({ reason }) => reason)).toEqual([`beyond the top ${SUGGESTIONS_KEPT}`, `beyond the top ${SUGGESTIONS_KEPT}`]);
  });

  it("counts no packages when the item isn't on the list any more", () => {
    const [suggestion] = rankFound([{ productId: '1', name: 'Firm Tofu', size: '14 oz', vegan }], { ...context, item: undefined }).suggestions;

    expect(suggestion).toMatchObject({ packages: null, why: [] });
  });
});

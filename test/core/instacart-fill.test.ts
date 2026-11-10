import { describe, expect, it } from 'vitest';
import { weekOf } from '../../src/core/calendar.ts';
import { fillRequest, fillTarget, newFillId } from '../../src/core/instacart-fill.ts';

describe('fill IDs', () => {
  it('lead back to the household and week they were made for, and differ every time', () => {
    const first = newFillId('h1', weekOf('2026-11-11'));

    expect(fillTarget(first)).toEqual({ householdId: 'h1', week: weekOf('2026-11-09') });
    expect(newFillId('h1', weekOf('2026-11-11'))).not.toBe(first);
  });

  it.each(['whatever', 'h1.2026-11-09', 'h1.2026-13-40.0f8fad5b-d9cb-469f-a165-70867728950e', 'h/1.2026-11-09.0f8fad5b-d9cb-469f-a165-70867728950e'])(
    'read nothing from %s',
    (fillId) => {
      expect(fillTarget(fillId)).toBeNull();
    },
  );
});

describe('fillRequest', () => {
  it("gives the fill routine one cart at the store, with lines sharing a product combined", () => {
    const lines = [
      { ingredient: 'extra-firm tofu', productId: '111', quantity: 1, name: null },
      { ingredient: 'firm tofu', productId: '111', quantity: 2, name: null },
      { ingredient: 'lemon', productId: '222', quantity: 1, name: null },
    ];

    expect(fillRequest('fill-1', 'Wegmans', lines)).toEqual({
      fill_id: 'fill-1',
      carts: [{ retailer: 'Wegmans', items: [{ product_id: '111', quantity: 3 }, { product_id: '222', quantity: 1 }] }],
    });
  });
});

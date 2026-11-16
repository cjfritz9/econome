import { describe, expect, it } from 'vitest';
import { weekOf } from '../../src/core/calendar.ts';
import { checkoutLink, fillOutcome, fillRequest, fillTarget, newFillId, storeCheckoutLink } from '../../src/core/instacart-fill.ts';

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
  it('gives the fill routine one cart at the store, with each item as Économe chose to send it', () => {
    expect(fillRequest('fill-1', 'Wegmans', [{ productId: '111', quantity: 3 }])).toEqual({
      fill_id: 'fill-1',
      carts: [{ retailer: 'Wegmans', items: [{ product_id: '111', quantity: 3 }] }],
    });
    expect(fillRequest('check-1', 'Wegmans', [])).toEqual({ fill_id: 'check-1', carts: [{ retailer: 'Wegmans', items: [] }] });
  });
});

describe('fillOutcome', () => {
  const approved = [
    { ingredient: 'extra-firm tofu', productId: '111', quantity: 2, name: 'Organic Extra Firm Tofu' },
    { ingredient: 'lemon', productId: '222', quantity: 2, name: null },
    { ingredient: 'dill', productId: '333', quantity: 1, name: 'Fresh Dill' },
  ];

  it("splits what was sent into what landed and what didn't, short or absent, with Instacart's words for each", () => {
    const sent = [
      { productId: '111', quantity: 2 },
      { productId: '222', quantity: 2 },
      { productId: '333', quantity: 1 },
    ];
    const inCart = [
      { productId: '111', quantity: 2, name: null },
      { productId: '222', quantity: 1, name: null },
      { productId: '999', quantity: 1, name: 'Cucumber' },
    ];

    expect(fillOutcome(sent, inCart, approved, { summary: 'Cart updated (added 1 item).', itemErrors: [{ productId: '333', message: 'Unavailable' }] })).toEqual({
      missed: [
        { productId: '222', name: 'lemon', said: 'Cart updated (added 1 item).' },
        { productId: '333', name: 'Fresh Dill', said: 'Unavailable' },
      ],
      landed: ['111'],
    });
  });

  it('judges only what was sent, so lines a top-up left alone count neither way', () => {
    expect(fillOutcome([{ productId: '222', quantity: 2 }], [{ productId: '222', quantity: 2, name: null }], approved, { summary: null, itemErrors: [] })).toEqual({
      missed: [],
      landed: ['222'],
    });
  });
});

describe('checkoutLink', () => {
  it("keeps Instacart's checkout link for the cart, without its tracking parameters", () => {
    expect(checkoutLink('https://www.instacart.com/store/checkout_v4?sid=1234&cartId=987&utm_source=fig&utm_campaign=x')).toBe(
      'https://www.instacart.com/store/checkout_v4?sid=1234&cartId=987',
    );
  });

  it.each([undefined, null, '', 'not a link', 'http://www.instacart.com/store/checkout_v4?sid=1234', 'https://evil.example.com/store/checkout_v4?sid=1234'])(
    'refuses %s',
    (reported) => {
      expect(checkoutLink(reported)).toBeNull();
    },
  );

  it("builds a store's checkout link from its id when there's no cart link yet", () => {
    expect(storeCheckoutLink('1234')).toBe('https://www.instacart.com/store/checkout_v4?sid=1234');
  });
});

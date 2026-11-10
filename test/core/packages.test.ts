import { describe, expect, it } from 'vitest';
import { packagesFor, parseSize } from '../../src/core/packages.ts';

const weights = { gramsPerMl: 118 / 236.588, unitWeights: { piece: 136 } };

describe('parseSize', () => {
  it.each([
    ['14 oz', { kind: 'grams', grams: 396.893 }],
    ['1 lb', { kind: 'grams', grams: 453.592 }],
    ['32 fl oz', { kind: 'ml', ml: 946.352 }],
    ['1/2 gal', { kind: 'ml', ml: 1892.705 }],
    ['4 ct', { kind: 'count', count: 4 }],
    ['1 each', { kind: 'count', count: 1 }],
    ['4 ct / 14.5 oz', { kind: 'grams', grams: 1644.271 }],
  ])('reads %s', (text, size) => {
    const parsed = parseSize(text);
    expect(parsed?.kind).toBe(size.kind);
    for (const [key, value] of Object.entries(size)) if (typeof value === 'number') expect(parsed).toHaveProperty(key, expect.closeTo(value, 2));
  });

  it("can't read a size that isn't one", () => {
    expect(parseSize('front')).toBeNull();
    expect(parseSize(null)).toBeNull();
  });
});

describe('packagesFor', () => {
  it('rounds up to whole packages by weight, through the density for cups', () => {
    expect(packagesFor({ value: 7, unit: 'cup' }, '12 oz', weights)).toBe(3);
  });

  it('allows packages to come up to 10% short rather than buying another', () => {
    expect(packagesFor({ value: 2, unit: 'can', eachGrams: 425.24 }, '14.28 oz', weights)).toBe(2);
    expect(packagesFor({ value: 6, unit: 'cup' }, '12 oz', weights)).toBe(2);
    expect(packagesFor({ value: 2.5, unit: 'piece' }, '1 each', weights)).toBe(3);
  });

  it("uses a block's stated size", () => {
    expect(packagesFor({ value: 3, unit: 'block', eachGrams: 396.893 }, '14 oz', weights)).toBe(3);
  });

  it('counts items against a counted package', () => {
    expect(packagesFor({ value: 1, unit: 'piece' }, '4 ct', weights)).toBe(1);
    expect(packagesFor({ value: 2, unit: 'piece' }, '1 each', weights)).toBe(2);
  });

  it('compares volumes directly', () => {
    expect(packagesFor({ value: 2.5, unit: 'cup' }, '32 oz', { gramsPerMl: 1, unitWeights: {} })).toBe(1);
    expect(packagesFor({ value: 5, unit: 'cup' }, '32 fl oz', weights)).toBe(2);
  });

  it('counts one product per can, jar or block when the sizes can\'t be compared', () => {
    expect(packagesFor({ value: 1, unit: 'can' }, '13.5 fl oz', { gramsPerMl: null, unitWeights: {} })).toBe(1);
  });

  it("doesn't guess without a way to compare", () => {
    expect(packagesFor({ value: 4, unit: 'clove' }, '1 ct', weights)).toBeNull();
    expect(packagesFor({ value: 2, unit: 'tsp' }, '1 lb', { gramsPerMl: null, unitWeights: {} })).toBeNull();
  });
});

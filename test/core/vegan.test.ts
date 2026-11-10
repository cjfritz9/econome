import { describe, expect, it } from 'vitest';
import { checkVegan, concernKey, concernsToCount, ingredientsHash, nameConcerns, type LabelFacts } from '../../src/core/vegan.ts';

const label = (overrides: Partial<LabelFacts> = {}): LabelFacts => ({
  ingredients: 'Water, Organic Soybeans, Calcium Sulfate.',
  categories: [],
  declarations: [],
  contains: [],
  mayContain: [],
  ...overrides,
});

describe('checkVegan', () => {
  it('fails on an animal allergen the label says it contains', () => {
    expect(checkVegan(label({ contains: ['Milk and its Derivatives'] }))).toMatchObject({ verdict: 'non-vegan', source: 'allergens' });
  });

  it("passes on the maker's vegan declaration", () => {
    expect(checkVegan(label({ declarations: ['Organic', 'Vegan'], ingredients: 'Sugar, natural flavors' }))).toMatchObject({
      verdict: 'vegan',
      source: 'declaration',
    });
  });

  it('passes a clean ingredient list without a declaration', () => {
    expect(checkVegan(label())).toEqual({ verdict: 'vegan', reasons: ['no animal ingredients in its list'], source: 'ingredients' });
  });

  it.each([
    ['whey', 'Sugar, Whey Protein'],
    ['milk', 'Cocoa, Milk, Sugar'],
    ['egg', 'Flour, Eggs, Water'],
    ['honey', 'Oats, Honey'],
    ['gelatin', 'Sugar, Gelatin'],
    ['fish', 'Soy Sauce, Anchovies'],
  ])('fails on %s in the ingredients', (_name, ingredients) => {
    expect(checkVegan(label({ ingredients })).verdict).toBe('non-vegan');
  });

  it.each([
    ['almond milk', 'Almond Milk (Water, Almonds), Tapioca Starch'],
    ['coconut cream', 'Coconut Cream, Water'],
    ['peanut butter', 'Peanut Butter, Salt'],
    ['eggplant', 'Eggplant, Olive Oil'],
    ['cream of tartar', 'Cream of Tartar, Baking Soda'],
    ['organic cane sugar', 'Organic Cane Sugar, Cocoa'],
    ['soy lecithin', 'Chocolate, Soy Lecithin'],
    ['butter beans', 'Butter Beans, Water, Salt'],
  ])('passes %s', (_name, ingredients) => {
    expect(checkVegan(label({ ingredients })).verdict).toBe('vegan');
  });

  it('asks about questionable ingredients and shared-equipment warnings, with each reason', () => {
    const check = checkVegan(label({ ingredients: 'Water, Sugar, Natural Flavors', mayContain: ['Milk and its Derivatives'] }));

    expect(check.verdict).toBe('needs-review');
    expect(check.reasons).toEqual([
      'natural flavors: may be animal-derived',
      'sugar: may be filtered with bone char',
      'may contain Milk and its Derivatives: shared equipment',
    ]);
  });

  it("decides a concern from three matching answers and none the other way, saying it's from the household's reviews", () => {
    const tallies = new Map([['natural flavors', { ok: 3, notOk: 0 }]]);

    expect(checkVegan(label({ ingredients: 'Water, Natural Flavors' }), tallies)).toEqual({
      verdict: 'vegan',
      reasons: ['natural flavors: OK by your past reviews'],
      source: 'your past reviews',
    });
  });

  it('never decides a meat named in the ingredients from past answers, so real meat is always asked about', () => {
    const tallies = new Map([['names a meat', { ok: 5, notOk: 0 }]]);
    const check = checkVegan(label({ ingredients: 'Prepared Lima Beans, Water, Cured Pork (Pork Fatback), Salt' }), tallies);

    expect(check.verdict).toBe('needs-review');
    expect(concernsToCount(check)).toEqual([]);
  });

  it('keeps a concern in review while answers disagree, and refuses one answered no three times', () => {
    const disagree = new Map([['natural flavors', { ok: 3, notOk: 1 }]]);
    const refused = new Map([['natural flavors', { ok: 0, notOk: 3 }]]);
    const facts = label({ ingredients: 'Water, Natural Flavors' });

    expect(checkVegan(facts, disagree).verdict).toBe('needs-review');
    expect(checkVegan(facts, refused).verdict).toBe('non-vegan');
  });

  it("uses the household's review of the product until its ingredients change", () => {
    const facts = label({ ingredients: 'Water, Natural Flavors' });
    const review = { vegan: true, ingredientsHash: ingredientsHash('water,  NATURAL flavors') };

    expect(checkVegan(facts, new Map(), review).source).toBe('your review');
    expect(checkVegan(label({ ingredients: 'Water, Natural Flavors, Whey' }), new Map(), review).verdict).toBe('non-vegan');
  });

  it('counts unlabelled produce as vegan, and asks about anything else without an ingredient list', () => {
    expect(checkVegan(label({ ingredients: null, categories: ['Produce'] })).verdict).toBe('vegan');
    expect(checkVegan(label({ ingredients: null, categories: ['Pantry'] }))).toMatchObject({ verdict: 'needs-review', source: 'no ingredient list' });
  });
});

describe('concernKey', () => {
  it('names a concern by the part before its explanation', () => {
    expect(concernKey('Natural Flavors: may be animal-derived')).toBe('natural flavors');
  });
});

describe('concernsToCount', () => {
  it("counts the questionable ingredients a review answers, so they can be decided later", () => {
    expect(concernsToCount(checkVegan(label({ ingredients: 'Water, Natural Flavors' })))).toEqual(['natural flavors']);
  });

  it('never counts a missing ingredient list, so products without one are always asked about', () => {
    expect(concernsToCount(checkVegan(label({ ingredients: null })))).toEqual([]);
  });
});

describe('nameConcerns', () => {
  it('flags a product name that mentions an animal ingredient', () => {
    expect(nameConcerns("Luck's Giant Lima Beans Seasoned with Pork")).toEqual(['the name says "pork": check it\'s plant-based']);
    expect(nameConcerns('Honey Wheat Bread')).toEqual(['the name says "honey": check it\'s plant-based']);
  });

  it('lets names that say they are plant-based, and foods that only sound animal, through', () => {
    expect(nameConcerns("Morning Star Farms Plant Based Crispy Chik'n Nuggets")).toEqual([]);
    expect(nameConcerns('Violife Just Like Mozzarella Shreds Cheese Alternative, Dairy-Free Vegan')).toEqual([]);
    expect(nameConcerns('Bush\'s Large Butter Beans')).toEqual([]);
    expect(nameConcerns('Fresh Large Red Beefsteak Tomato')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { bestLabel, checkProduct, labelQuery, reviewHash } from '../../src/core/product-check.ts';
import type { BrandedFood } from '../../src/sources/fdc.ts';

const food = (fdcId: number, description: string, brand: string | null, ingredients: string | null): BrandedFood => ({
  fdcId,
  description,
  brand,
  owner: null,
  ingredients,
});

const violife = food(1, 'Violife Cheese Alternatives, Just Like Mozzarella Shreds', 'Violife', 'Filtered Water, Coconut Oil, Potato Starch, Salt');
const hodo = food(2, 'EXTRA FIRM ORGANIC TOFU, EXTRA FIRM', 'HODO', 'Water, Organic Soybeans, Calcium Sulfate');
const lucks = food(3, 'GIANT LIMA BEANS SEASONED WITH PORK', "LUCK'S", 'Prepared Giant Lima Beans, Water, Cured Pork (Pork Fatback, Water and Salt) and Salt.');
const burger = food(4, 'MORNING STAR FARMS, SPICY BLACK BEANS VEGGIE BURGER', 'MORNINGSTAR FARMS', 'Water, Cooked Black Beans');
const garlicBread = food(5, 'WEGMANS, GARLIC BREAD', 'WEGMANS', 'Enriched Flour, Butter, Garlic');
const superSoft = food(6, 'SUPER SOFT WHOLE WHEAT TORTILLA WRAPS', 'MISSION', 'Whole Wheat Flour, Water');
const originalWraps = food(7, 'ORIGINAL WHOLE WHEAT TORTILLA WRAPS, ORIGINAL WHOLE WHEAT', 'MISSION', 'Whole Wheat Flour, Water');

describe('labelQuery', () => {
  it("drops the size and trademark signs from an Instacart name, so FoodData Central's search sees the product", () => {
    expect(labelQuery('Violife Just Like Mozzarella Shreds, 8 oz')).toBe('Violife Just Like Mozzarella Shreds');
    expect(labelQuery('Simple Truth Organic® Extra Firm Tofu')).toBe('Simple Truth Organic Extra Firm Tofu');
  });
});

describe('bestLabel', () => {
  it("takes the result from the product's own brand whose every described word is in the name, singular or plural", () => {
    expect(bestLabel('Violife Just Like Mozzarella Shreds Cheese Alternative, Dairy-Free Vegan', [hodo, violife])).toBe(violife);
    expect(bestLabel("Luck's Giant Lima Beans Seasoned with Pork", [lucks])).toBe(lucks);
  });

  it("finds nothing rather than another brand's product or a different product of the same brand", () => {
    expect(bestLabel('Wegmans Organic Extra Firm Tofu', [hodo])).toBeNull();
    expect(bestLabel("Morning Star Farms Plant Based Chik'n Nuggets, Original, Value Pack", [burger])).toBeNull();
    expect(bestLabel('Wegmans Organic Garlic, 3 Count', [garlicBread])).toBeNull();
  });

  it('prefers the description that names more of the product', () => {
    expect(bestLabel('Mission Super Soft Tortillas Wraps, Whole Wheat, Original', [originalWraps, superSoft])).toBe(superSoft);
  });

  it('skips results without an ingredient list', () => {
    expect(bestLabel('Violife Just Like Mozzarella Shreds', [{ ...violife, ingredients: null }])).toBeNull();
  });
});

describe('checkProduct', () => {
  it('judges a product by the ingredient list FoodData Central has for it', () => {
    expect(checkProduct('Violife Just Like Mozzarella Shreds', violife)).toMatchObject({
      verdict: 'vegan',
      label: 'Violife Cheese Alternatives, Just Like Mozzarella Shreds (Violife)',
    });
  });

  it('asks about a product whose name or ingredients name a meat, giving both reasons', () => {
    const check = checkProduct("Luck's Giant Lima Beans Seasoned with Pork", lucks);

    expect(check.verdict).toBe('needs-review');
    expect(check.reasons).toEqual(["names a meat: check it's plant-based", 'the name says "pork": check it\'s plant-based']);
  });

  it('asks about a product with no ingredient list found, so the household or Claude settles it once', () => {
    expect(checkProduct('Fresh Large Red Beefsteak Tomato', null)).toEqual({
      verdict: 'needs-review',
      reasons: ['no ingredient list found for it in FoodData Central'],
      source: 'no ingredient list',
      label: null,
    });
  });

  it("uses the household's review while the ingredient list stays the same", () => {
    const review = { vegan: true, ingredientsHash: reviewHash(null) };

    expect(checkProduct('Fresh Large Red Beefsteak Tomato', null, new Map(), review)).toMatchObject({ verdict: 'vegan', source: 'your review' });
    expect(checkProduct('Violife Just Like Mozzarella Shreds', violife, new Map(), review).source).toBe('ingredients');
  });
});

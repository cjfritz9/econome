import { describe, expect, it } from 'vitest';
import { buildList, totalNeed, type OnHand } from '../../src/core/shopping-list.ts';
import type { Ingredient, Recipe } from '../../src/data/recipes.ts';
import type { PlannedMeal } from '../../src/data/weeks.ts';
import type { LineParse } from '../../src/llm/parse-ingredients.ts';
import { entry, parsedLine, parseOf } from '../fakes.ts';

const none = { gramsPerMl: null, unitWeights: {} };

describe('totalNeed', () => {
  it('adds amounts in the same unit', () => {
    expect(totalNeed([parseOf('edamame', { amount: 4, unit: 'cup' }), parseOf('edamame', { amount: 2, unit: 'cup' })], none)).toEqual({
      need: '6 cup',
      amount: { value: 6, unit: 'cup' },
    });
  });

  it('adds volumes in different units, in the largest one used', () => {
    const parses = [parseOf('soy sauce', { amount: 2, unit: 'tbsp' }), parseOf('soy sauce', { amount: 1, unit: 'tsp' })];

    expect(totalNeed(parses, none)).toMatchObject({ need: '2.33 tbsp', amount: { unit: 'tbsp' } });
  });

  it('adds weights in different units, in the largest one used', () => {
    expect(totalNeed([parseOf('tofu', { amount: 1, unit: 'lb' }), parseOf('tofu', { amount: 8, unit: 'oz' })], none)).toMatchObject({
      need: '1.5 lb',
      amount: { unit: 'lb' },
    });
  });

  it('rounds a counted need up to whole items to buy', () => {
    expect(totalNeed([parseOf('lime', { amount: 0.5 }), parseOf('lime', { amount: 1 })], none)).toEqual({
      need: '1.5 piece',
      buy: '2 piece',
      amount: { value: 1.5, unit: 'piece' },
    });
  });

  it('combines different kinds of unit through the weights, in the counted unit', () => {
    const parses = [parseOf('green onion', { amount: 2, unit: 'tbsp' }), parseOf('green onion', { amount: 2 })];
    const weights = { gramsPerMl: 99 / 236.588, unitWeights: { piece: 15 } };

    expect(totalNeed(parses, weights)).toMatchObject({ need: '≈ 2.83 piece', buy: '3 piece', amount: { unit: 'piece' } });
  });

  it("uses a package's stated size to combine blocks with a weight", () => {
    const parses = [
      parseOf('tofu', { amount: 2, unit: 'block', packageSize: { amount: 14, unit: 'oz' } }),
      parseOf('tofu', { amount: 7, unit: 'oz' }),
    ];

    expect(totalNeed(parses, none)).toMatchObject({ need: '≈ 2.5 block', buy: '3 block', amount: { value: 2.5, unit: 'block' } });
  });

  it("keeps amounts apart, naming the missing weight, when they can't be combined", () => {
    const parses = [parseOf('green onion', { amount: 2, unit: 'tbsp' }), parseOf('green onion', { amount: 2 })];

    expect(totalNeed(parses, none)).toEqual({ parts: ['2 tbsp', '2 piece'], unweighed: ['tbsp', 'piece'] });
  });

  it('has nothing to add up without amounts', () => {
    expect(totalNeed([], none)).toBeNull();
  });
});

describe('buildList', () => {
  const line = (name: string, amount = 1, unit = 'piece'): Ingredient => ({ amount, unit, name });
  const recipe = (id: string, title: string, lines: Ingredient[]): Recipe => ({
    id,
    title,
    description: '',
    servings: 4,
    tags: [],
    ingredientGroups: [{ ingredients: lines }],
  });
  const meal = ({ id, title }: Recipe): PlannedMeal => ({ recipeId: id, title, servings: 4 });

  const curryTofu = line('extra-firm tofu', 2, 'block');
  const bowlTofu = line('extra firm tofu', 1, 'block');
  const soy = line('soy sauce or tamari', 2, 'tbsp');
  const saltPepper = line('salt and pepper', 1, 'pinch');
  const water = line('water', 1, 'cup');
  const capers = line('capers', 1, 'tbsp');
  const shallots = line('crispy shallots, to garnish', 1, 'piece');
  const rice = line('cooked rice', 1, 'cup');
  const unparsed = line('mystery spice', 1, 'tsp');

  const curry = recipe('curry', 'Curry', [curryTofu, soy, saltPepper, water, rice]);
  const bowl = recipe('bowl', 'Bowl', [bowlTofu, capers, shallots, unparsed]);

  const parses: [Ingredient, LineParse][] = [
    [curryTofu, parseOf('extra-firm tofu', { amount: 2, unit: 'block' })],
    [bowlTofu, parseOf('extra-firm tofu', { amount: 1, unit: 'block' })],
    [soy, parseOf('soy sauce', { amount: 2, unit: 'tbsp', alternatives: ['tamari'] })],
    [saltPepper, parseOf('salt', { unit: 'pinch', toTaste: true, alsoNeeded: ['black pepper'] })],
    [water, parseOf('water', { unit: 'cup' })],
    [capers, parseOf('capers', { unit: 'tbsp' })],
    [shallots, parseOf('shallot', { optional: true })],
    [rice, parseOf('rice', { unit: 'cup', measuredAs: 'cooked' })],
  ];
  const lines = new Map(parses.map(([text, parse]) => parsedLine(text, parse)).map((parsed) => [parsed.key, parsed]));
  const entries = [
    entry('extra-firm tofu', { buying: 'weekly' }),
    entry('soy sauce', { buying: 'staple' }),
    entry('salt', { buying: 'staple' }),
    entry('black pepper', { buying: 'staple' }),
    entry('rice', { buying: 'staple' }),
    entry('water', { buying: 'never' }),
  ];

  const list = buildList([meal(curry), meal(bowl)], [curry, bowl], lines, entries);

  it('merges an ingredient across recipes, with each recipe’s amount', () => {
    expect(list.buy.find(({ ingredient }) => ingredient === 'extra-firm tofu')).toEqual({
      ingredient: 'extra-firm tofu',
      need: '3 block',
      uses: ['Curry: 2 block', 'Bowl: 1 block'],
      amount: { value: 3, unit: 'block' },
    });
  });

  it('puts staples under probablyHave, with alternatives and lines that have no amount', () => {
    expect(list.probablyHave).toEqual([
      { ingredient: 'black pepper', need: null, uses: ['Curry: as needed, from "1 pinch | salt and pepper"'] },
      { ingredient: 'rice', need: null, uses: ['Curry: 1 cup cooked'] },
      { ingredient: 'salt', need: null, uses: ['Curry: to taste'] },
      { ingredient: 'soy sauce', need: '2 tbsp', alternatives: ['tamari'], uses: ['Curry: 2 tbsp'], amount: { value: 2, unit: 'tbsp' } },
    ]);
  });

  it('buys ingredients without a buying decision, marked as a first time so the household can say how it buys them', () => {
    expect(list.buy.filter(({ firstTime }) => firstTime)).toEqual([
      { ingredient: 'capers', need: '1 tbsp', firstTime: true, uses: ['Bowl: 1 tbsp'], amount: { value: 1, unit: 'tbsp' } },
      { ingredient: 'shallot', need: '1 piece', optional: true, firstTime: true, uses: ['Bowl: 1 piece (optional)'], amount: { value: 1, unit: 'piece' } },
    ]);
  });

  it('lists what is never bought on its own instead of dropping it', () => {
    expect(list.notBought).toEqual([{ ingredient: 'water', need: '1 cup', uses: ['Curry: 1 cup'], amount: { value: 1, unit: 'cup' } }]);
  });

  it('warns about every line it could not count', () => {
    expect(list.warnings).toEqual([
      'Bowl: "1 tsp | mystery spice" isn\'t parsed yet, so it\'s not on the list.',
      "Curry: rice is measured cooked, so it's not counted in how much to buy.",
    ]);
  });

  it('warns about a planned recipe that can no longer be planned', () => {
    const gone = buildList([{ recipeId: 'old', title: 'Old Stew', servings: 2 }], [], lines, entries);

    expect(gone.warnings).toEqual([
      "Old Stew can't be planned any more (archived, or tagged not-a-meal), so it adds nothing to the list.",
    ]);
  });

  it("moves answered items: a running-low staple to buy, and anything on hand to have", () => {
    const answered = buildList([meal(curry), meal(bowl)], [curry, bowl], lines, entries, {
      'soy sauce': false,
      'extra-firm tofu': true,
      salt: true,
      capers: true,
    });

    expect(answered.buy.map(({ ingredient }) => ingredient)).toEqual(['shallot', 'soy sauce']);
    expect(answered.buy.find(({ ingredient }) => ingredient === 'soy sauce')).toEqual({
      ingredient: 'soy sauce',
      need: '2 tbsp',
      alternatives: ['tamari'],
      runningLow: true,
      uses: ['Curry: 2 tbsp'],
      amount: { value: 2, unit: 'tbsp' },
    });
    expect(answered.have.map(({ ingredient }) => ingredient)).toEqual(['capers', 'extra-firm tofu', 'salt']);
    expect(answered.probablyHave.map(({ ingredient }) => ingredient)).toEqual(['black pepper', 'rice']);
  });

  it('takes an amount on hand off the need, and moves the item to have once it covers it', () => {
    const tofu = (answer: OnHand) =>
      buildList([meal(curry), meal(bowl)], [curry, bowl], lines, entries, { 'extra-firm tofu': answer });

    expect(tofu({ amount: 1, unit: 'block' }).buy.find(({ ingredient }) => ingredient === 'extra-firm tofu')).toMatchObject({
      need: '2 block',
      amount: { value: 2, unit: 'block' },
      onHand: { amount: 1, unit: 'block' },
    });
    expect(tofu({ amount: 3, unit: 'block' }).have).toEqual([expect.objectContaining({ ingredient: 'extra-firm tofu', onHand: { amount: 3, unit: 'block' } })]);
  });

  it('keeps packs on hand for the package count, and warns about an amount in a unit it cannot take off', () => {
    const packs = buildList([meal(curry), meal(bowl)], [curry, bowl], lines, entries, { 'extra-firm tofu': { amount: 1, unit: 'pack' } });
    const grams = buildList([meal(curry), meal(bowl)], [curry, bowl], lines, entries, { 'extra-firm tofu': { amount: 200, unit: 'g' } });

    expect(packs.buy.find(({ ingredient }) => ingredient === 'extra-firm tofu')).toMatchObject({ need: '3 block', onHand: { amount: 1, unit: 'pack' } });
    expect(grams.warnings).toContain("extra-firm tofu: 200 g on hand can't be taken off 3 block; say how many packs instead.");
  });

  it('keeps what is never bought under notBought whatever the answer', () => {
    expect(buildList([meal(curry)], [curry], lines, entries, { water: true }).notBought).toHaveLength(1);
  });

  it('counts a recipe planned twice twice', () => {
    const twice = buildList([meal(curry), meal(curry)], [curry], lines, entries);

    expect(twice.buy[0]).toMatchObject({ need: '4 block', uses: ['Curry: 2 block', 'Curry: 2 block'] });
  });
});

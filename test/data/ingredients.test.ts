import { describe, expect, it } from 'vitest';
import {
  addAlias,
  aliasMap,
  describeIngredients,
  describeWeights,
  removeAlias,
  setBuying,
  withAliases,
  withFdcQuery,
  withFood,
  withUnitWeight,
} from '../../src/data/ingredients.ts';
import { entry, parseOf } from '../fakes.ts';

describe('withAliases', () => {
  const aliases = aliasMap([entry('salt', { aliases: ['kosher salt', 'sea salt'] }), entry('soy sauce', { aliases: ['tamari'] })]);

  it('maps the ingredient, alternatives and alsoNeeded to household names, in any letter case', () => {
    const parse = withAliases(parseOf('Kosher Salt', { alternatives: ['tamari'], alsoNeeded: ['black pepper'] }), aliases);

    expect(parse).toMatchObject({ ingredient: 'salt', alternatives: ['soy sauce'], alsoNeeded: ['black pepper'] });
  });

  it("drops an alternative that becomes the ingredient itself, and doesn't repeat one", () => {
    const parse = withAliases(parseOf('salt', { alternatives: ['sea salt', 'kosher salt', 'tamari', 'soy sauce'] }), aliases);

    expect(parse.alternatives).toEqual(['soy sauce']);
  });

  it('leaves names without an alias as they are', () => {
    expect(withAliases(parseOf('garlic'), aliases).ingredient).toBe('garlic');
  });
});

describe('addAlias', () => {
  it("creates the target's entry when it has none, with the alias lowercased", () => {
    const { saved, removedIds } = addAlias([], 'Kosher Salt', 'salt');

    expect(saved).toEqual([entry('salt', { aliases: ['kosher salt'] })]);
    expect(removedIds).toEqual([]);
  });

  it("merges the old name's entry into the target, keeping the target's buying, and removes it", () => {
    const old = entry('scallion', { aliases: ['spring onion'], buying: 'weekly' });
    const target = entry('green onion', { buying: 'staple' });

    const { saved, removedIds } = addAlias([old, target], 'scallion', 'green onion');

    expect(saved[0]).toEqual({ ...target, aliases: ['scallion', 'spring onion'] });
    expect(removedIds).toEqual(['scallion']);
  });

  it("takes the old entry's buying when the target has none", () => {
    const { saved } = addAlias([entry('sea salt', { buying: 'staple' })], 'sea salt', 'salt');

    expect(saved[0]?.buying).toBe('staple');
  });

  it('moves an alias away from another ingredient and repoints comesWith', () => {
    const elsewhere = entry('sea salt', { aliases: ['kosher salt'] });
    const sauce = entry('adobo sauce', { buying: 'never', comesWith: 'chipotles' });
    const chipotles = entry('chipotles');

    const { saved } = addAlias([elsewhere, sauce, chipotles], 'chipotles', 'chipotle pepper in adobo sauce');
    const moved = addAlias([elsewhere], 'kosher salt', 'salt').saved;

    expect(saved).toContainEqual({ ...sauce, comesWith: 'chipotle pepper in adobo sauce' });
    expect(moved).toContainEqual({ ...elsewhere, aliases: [] });
  });

  it('refuses to alias a name to itself', () => {
    expect(() => addAlias([], 'Salt', 'salt')).toThrow(/same name/);
  });
});

describe('removeAlias', () => {
  it('takes the alias off its ingredient', () => {
    expect(removeAlias([entry('salt', { aliases: ['kosher salt', 'sea salt'] })], 'Kosher Salt').aliases).toEqual(['sea salt']);
  });

  it('says when no ingredient has the alias', () => {
    expect(() => removeAlias([entry('salt')], 'kosher salt')).toThrow(/No ingredient has the alias/);
  });
});

describe('setBuying', () => {
  it('sets buying on existing and new entries, once per name', () => {
    const saved = setBuying([entry('salt', { aliases: ['sea salt'] })], ['salt', 'cumin', 'salt'], 'staple', null);

    expect(saved).toEqual([entry('salt', { aliases: ['sea salt'], buying: 'staple' }), entry('cumin', { buying: 'staple' })]);
  });

  it('keeps comesWith only for never', () => {
    const [never] = setBuying([], ['adobo sauce'], 'never', 'chipotle pepper in adobo sauce');
    const [weekly] = setBuying([never!], ['adobo sauce'], 'weekly', 'ignored');

    expect(never?.comesWith).toBe('chipotle pepper in adobo sauce');
    expect(weekly?.comesWith).toBeNull();
  });
});

describe('withFood', () => {
  const food = { fdcId: 11, description: 'Cucumber, raw', per100g: null, source: 'claude' as const, doubt: null };

  it("sets the food and fills only the weights the household hasn't set", () => {
    const saved = withFood([entry('cucumber', { buying: 'weekly', unitWeights: { piece: 400 } })], 'cucumber', food, {
      gramsPerMl: 0.95,
      unitWeights: { piece: 300, slice: 7 },
    });

    expect(saved).toEqual(entry('cucumber', { buying: 'weekly', food, gramsPerMl: 0.95, unitWeights: { piece: 400, slice: 7 } }));
  });

  it('creates an entry for an ingredient with none yet', () => {
    expect(withFood([], 'white wine', food).food).toEqual(food);
  });
});

describe('withFdcQuery', () => {
  it("keeps the ingredient's other details and stores the trimmed search term", () => {
    expect(withFdcQuery([entry('lemongrass', { buying: 'weekly' })], 'lemongrass', ' lemon grass ')).toEqual(
      entry('lemongrass', { buying: 'weekly', fdcQuery: 'lemon grass' }),
    );
  });
});

describe('withUnitWeight', () => {
  it('turns a volume into a density and keeps a counted unit as a weight', () => {
    expect(withUnitWeight([], 'flour', 'cup', 125).gramsPerMl).toBeCloseTo(0.528, 3);
    expect(withUnitWeight([entry('cucumber', { unitWeights: { slice: 7 } })], 'cucumber', 'piece', 400).unitWeights).toEqual({ slice: 7, piece: 400 });
  });

  it('refuses a unit that is already a weight', () => {
    expect(() => withUnitWeight([], 'flour', 'oz', 28)).toThrow(/already a weight/);
  });
});

describe('describeWeights', () => {
  it('shows the density as a cup and each counted unit', () => {
    expect(describeWeights({ gramsPerMl: 0.528, unitWeights: { piece: 400.4 } })).toEqual(['1 cup = 125 g', '1 piece = 400 g']);
  });
});

describe('describeIngredients', () => {
  it('shows each name with its buying, comesWith and aliases, undecided when it has no entry', () => {
    const index = [
      { ingredient: 'adobo sauce', lines: ['1 tbsp | adobo sauce'] },
      { ingredient: 'garlic', lines: ['2 cloves | garlic'] },
    ];
    const entries = [
      entry('adobo sauce', { buying: 'never', comesWith: 'chipotle pepper in adobo sauce' }),
      entry('salt', { aliases: ['kosher salt'], buying: 'staple' }),
    ];

    expect(describeIngredients(index, entries)).toEqual([
      { ingredient: 'adobo sauce', buying: 'never', comesWith: 'chipotle pepper in adobo sauce', lines: ['1 tbsp | adobo sauce'] },
      { ingredient: 'garlic', buying: 'undecided', lines: ['2 cloves | garlic'] },
      { ingredient: 'salt', buying: 'staple', aliases: ['kosher salt'], lines: [] },
    ]);
  });

  it('shows the matched food, or that none fits, and the weights', () => {
    const food = { fdcId: 11, description: 'Cucumber, raw', per100g: null, source: 'claude' as const, doubt: null };
    const entries = [
      entry('cucumber', { food, fdcQuery: 'cucumber raw', unitWeights: { piece: 400 } }),
      entry('furikake', { food: { ...food, fdcId: null, description: null } }),
    ];

    expect(describeIngredients([], entries)).toEqual([
      { ingredient: 'cucumber', buying: 'undecided', food: 'Cucumber, raw', searchAs: 'cucumber raw', weights: ['1 piece = 400 g'], lines: [] },
      { ingredient: 'furikake', buying: 'undecided', food: 'no FDC food', lines: [] },
    ]);
  });
});

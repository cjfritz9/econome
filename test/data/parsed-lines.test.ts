import { describe, expect, it } from 'vitest';
import { correctLine, ingredientIndex, renameIngredient } from '../../src/data/parsed-lines.ts';
import { parsedLine, parseOf } from '../fakes.ts';

const scallions = parsedLine({ amount: 2, unit: 'piece', name: 'scallions, chopped' }, parseOf('scallion'));
const onions = parsedLine({ amount: 1, unit: 'piece', name: 'green onion' }, parseOf('green onion'));
const garnish = parsedLine(
  { amount: 2, unit: 'tbsp', name: 'chives or scallions' },
  parseOf('chive', { alternatives: ['scallion'] }),
);

describe('correctLine', () => {
  it('changes only the given fields and marks the line corrected', () => {
    const corrected = correctLine(scallions, { ingredient: 'green onion', prep: 'chopped' });

    expect(corrected.parse).toEqual({ ...scallions.parse, ingredient: 'green onion', prep: 'chopped' });
    expect(corrected.source).toBe('corrected');
  });

  it('refuses a change that breaks the parse shape', () => {
    expect(() => correctLine(scallions, { amount: -1 })).toThrow();
  });
});

describe('renameIngredient', () => {
  it('renames the ingredient wherever it appears, alternatives included, and returns only the changed lines', () => {
    const renamed = renameIngredient([scallions, onions, garnish], 'scallion', 'green onion');

    expect(renamed.map(({ parse }) => [parse.ingredient, parse.alternatives])).toEqual([
      ['green onion', []],
      ['chive', ['green onion']],
    ]);
    expect(renamed.every(({ source }) => source === 'corrected')).toBe(true);
  });

  it("doesn't list a name twice when it merges into one already there", () => {
    const both = parsedLine({ amount: 1, unit: 'tsp', name: 'tamari or soy sauce' }, parseOf('salt', { alsoNeeded: ['tamari', 'soy sauce'] }));

    expect(renameIngredient([both], 'tamari', 'soy sauce')[0]?.parse.alsoNeeded).toEqual(['soy sauce']);
  });
});

describe('ingredientIndex', () => {
  it('groups the source lines under each ingredient, sorted', () => {
    expect(ingredientIndex([onions, scallions, garnish])).toEqual([
      { ingredient: 'chive', lines: ['2 tbsp | chives or scallions'] },
      { ingredient: 'green onion', lines: ['1 piece | green onion'] },
      { ingredient: 'scallion', lines: ['2 piece | scallions, chopped'] },
    ]);
  });
});

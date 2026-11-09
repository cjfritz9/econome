import { describe, expect, it } from 'vitest';
import { matchFood, matchPrompt } from '../../src/llm/match-food.ts';
import { answeringClaude, fdcFood, household } from '../fakes.ts';

const candidates = [
  fdcFood(11, 'Cucumber, raw', { dataType: 'Survey (FNDDS)', portions: ['1 regular = 200 g'] }),
  fdcFood(12, 'Cucumber salad', { per100g: { kcal: 34, protein: null, carbs: 6.8, sugar: 5.3, fiber: 0.5, fat: 0.1 } }),
];
const request = { ingredient: 'english cucumber', lines: ['2 piece | large English cucumbers'], units: ['piece' as const], needsDensity: false, candidates };

describe('matchPrompt', () => {
  it('lists the lines, what to weigh and the numbered candidates with nutrition and portions', () => {
    expect(matchPrompt(request)).toBe(
      [
        'Ingredient: english cucumber',
        "The household's recipe lines:",
        '- 2 piece | large English cucumbers',
        'Units to weigh: piece',
        'Grams per milliliter needed: no',
        'Candidates:',
        '1. Cucumber, raw [Survey (FNDDS)]; per 100 g: 100 kcal, 10 g protein, 5 g carbs, 1 g sugar, 4 g fat; portions: 1 regular = 200 g',
        '2. Cucumber salad [SR Legacy]; per 100 g: 34 kcal, ? g protein, 6.8 g carbs, 5.3 g sugar, 0.1 g fat',
      ].join('\n'),
    );
  });
});

describe('matchFood', () => {
  it('returns the chosen candidate and only the weights that were asked for', async () => {
    const { claude } = answeringClaude(() => ({
      candidate: 1,
      gramsPerMl: 0.95,
      unitWeights: [
        { unit: 'piece', grams: 400 },
        { unit: 'slice', grams: 7 },
      ],
      doubt: null,
    }));

    const result = await matchFood(claude, household, request);

    expect(result).toEqual({ food: candidates[0], gramsPerMl: null, unitWeights: { piece: 400 }, doubt: null });
  });

  it('returns no food for candidate 0', async () => {
    const { claude } = answeringClaude(() => ({ candidate: 0, gramsPerMl: null, unitWeights: [], doubt: 'only dishes' }));

    expect((await matchFood(claude, household, request)).food).toBeNull();
  });

  it('refuses a candidate number past the list', async () => {
    const { claude } = answeringClaude(() => ({ candidate: 3, gramsPerMl: null, unitWeights: [], doubt: null }));

    await expect(matchFood(claude, household, request)).rejects.toThrow(/candidate 3 of 2/);
  });
});

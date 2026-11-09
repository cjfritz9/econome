import { describe, expect, it } from 'vitest';
import { ingredientUsage, matchFoods } from '../../src/core/food-matching.ts';
import { SpendCapError, type Claude } from '../../src/llm/claude.ts';
import { answeringClaude, entry, fakeFoodData, fdcFood, household, memoryIngredients, memoryParsedLines, parsedLine, parseOf } from '../fakes.ts';

const cucumber = parsedLine({ amount: 2, unit: 'piece', name: 'large cucumbers' }, parseOf('cucumber', { amount: 2, unit: 'piece' }));
const flour = parsedLine({ amount: 1, unit: 'cup', name: 'flour' }, parseOf('flour', { unit: 'cup' }));
const beans = parsedLine(
  { amount: 1, unit: 'can', name: 'black beans (15oz)' },
  parseOf('black beans', { unit: 'can', packageSize: { amount: 15, unit: 'oz' } }),
);
const broth = parsedLine(
  { amount: 1, unit: 'bottle', name: 'broth (32 fl oz)' },
  parseOf('broth', { unit: 'bottle', packageSize: { amount: 32, unit: 'fl oz' } }),
);

describe('ingredientUsage', () => {
  it('asks for loose counted units and for a density when anything is measured by volume', () => {
    const usage = ingredientUsage([cucumber, flour, beans, broth]);

    expect(usage.get('cucumber')).toEqual({ lines: ['2 piece | large cucumbers'], units: ['piece'], needsDensity: false });
    expect(usage.get('flour')).toMatchObject({ units: [], needsDensity: true });
    expect(usage.get('black beans')).toMatchObject({ units: [], needsDensity: false });
    expect(usage.get('broth')).toMatchObject({ units: [], needsDensity: true });
  });
});

describe('matchFoods', () => {
  const answer = { candidate: 1, gramsPerMl: null, unitWeights: [{ unit: 'piece', grams: 300 }], doubt: null };

  it('matches only unmatched ingredients, saving the food and weights but keeping weights already set', async () => {
    const { store: parsedLines } = memoryParsedLines([cucumber, flour]);
    const { store: ingredients, stored } = memoryIngredients([
      entry('cucumber', { buying: 'weekly', unitWeights: { piece: 400 } }),
      entry('flour', { food: { fdcId: 5, description: 'Flour', per100g: null, source: 'claude', doubt: null } }),
    ]);
    const { foodData, queries } = fakeFoodData({ cucumber: [fdcFood(11, 'Cucumber, raw')] });
    const { claude } = answeringClaude(() => answer);

    const run = await matchFoods({ claude, fdc: foodData, ingredients, parsedLines }, household, { limit: 25 });

    expect(queries).toEqual(['cucumber']);
    expect(run).toMatchObject({ matched: 1, remaining: 0, unsure: [], noFood: [], failed: [] });
    expect(stored.get('cucumber')).toMatchObject({
      buying: 'weekly',
      food: { fdcId: 11, description: 'Cucumber, raw', source: 'claude' },
      unitWeights: { piece: 400 },
    });
  });

  it("rematches Claude's matches but not the household's", async () => {
    const { store: parsedLines } = memoryParsedLines([cucumber, flour]);
    const { store: ingredients } = memoryIngredients([
      entry('cucumber', { food: { fdcId: 1, description: 'old', per100g: null, source: 'claude', doubt: null } }),
      entry('flour', { food: { fdcId: 5, description: 'Flour', per100g: null, source: 'corrected', doubt: null } }),
    ]);
    const { foodData, queries } = fakeFoodData({ cucumber: [fdcFood(11, 'Cucumber, raw')] });
    const { claude } = answeringClaude(() => answer);

    await matchFoods({ claude, fdc: foodData, ingredients, parsedLines }, household, { rematch: true, limit: 25 });

    expect(queries).toEqual(['cucumber']);
  });

  it('records no food without asking Claude when the search finds nothing, and reports unsure matches', async () => {
    const { store: parsedLines } = memoryParsedLines([cucumber, flour]);
    const { store: ingredients, stored } = memoryIngredients();
    const { foodData } = fakeFoodData({ flour: [fdcFood(5, 'Flour')] });
    const { claude, prompts } = answeringClaude(() => ({ ...answer, doubt: 'bleached or not is unclear' }));

    const run = await matchFoods({ claude, fdc: foodData, ingredients, parsedLines }, household, { limit: 25 });

    expect(prompts).toHaveLength(1);
    expect(run.noFood).toEqual([{ ingredient: 'cucumber', reason: 'FoodData Central found nothing for this name' }]);
    expect(run.unsure).toEqual([{ ingredient: 'flour', food: 'Flour', doubt: 'bleached or not is unclear' }]);
    expect(stored.get('cucumber')?.food?.fdcId).toBeNull();
  });

  it("searches with the household's search term when it has one", async () => {
    const { store: parsedLines } = memoryParsedLines([cucumber]);
    const { store: ingredients } = memoryIngredients([entry('cucumber', { fdcQuery: 'cucumber with peel' })]);
    const { foodData, queries } = fakeFoodData({ 'cucumber with peel': [fdcFood(11, 'Cucumber, with peel, raw')] });
    const { claude } = answeringClaude(() => answer);

    await matchFoods({ claude, fdc: foodData, ingredients, parsedLines }, household, { limit: 25 });

    expect(queries).toEqual(['cucumber with peel']);
  });

  it('works through a batch at a time and says how many remain', async () => {
    const { store: parsedLines } = memoryParsedLines([cucumber, flour, beans]);
    const { foodData } = fakeFoodData({ cucumber: [fdcFood(11, 'Cucumber')], flour: [fdcFood(5, 'Flour')], 'black beans': [fdcFood(7, 'Beans')] });
    const { claude } = answeringClaude(() => answer);

    const run = await matchFoods({ claude, fdc: foodData, ingredients: memoryIngredients().store, parsedLines }, household, { limit: 2 });

    expect(run).toMatchObject({ matched: 2, remaining: 1 });
  });

  it('stops at the daily cap and keeps what it matched', async () => {
    const { store: parsedLines } = memoryParsedLines([cucumber, flour]);
    const { store: ingredients, stored } = memoryIngredients();
    const { foodData } = fakeFoodData({ cucumber: [fdcFood(11, 'Cucumber')], flour: [fdcFood(5, 'Flour')] });
    let calls = 0;
    const claude: Claude = {
      ask: async (h, request) => {
        calls += 1;
        if (calls > 1) throw new SpendCapError('Daily cap reached');
        return answeringClaude(() => answer).claude.ask(h, request);
      },
    };

    const run = await matchFoods({ claude, fdc: foodData, ingredients, parsedLines }, household, { limit: 25 });

    expect(run).toMatchObject({ matched: 1, remaining: 1, stopped: 'Daily cap reached' });
    expect(stored.size).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { lineKey } from '../../src/core/ingredient-lines.ts';
import { parseRecipes, undecidedIngredients, unsureLines, withNameCheck } from '../../src/core/parsing.ts';
import { SpendCapError, type Claude } from '../../src/llm/claude.ts';
import {
  answeringClaude,
  entry,
  household,
  memoryIngredients,
  memoryNotes,
  memoryParsedLines,
  note,
  parsedLine,
  parseOf,
  recipeWith,
} from '../fakes.ts';

const salt = { amount: 1, unit: 'tsp', name: 'salt' };
const garlic = { amount: 2, unit: 'cloves', name: 'garlic' };
const tofu = { amount: 1, unit: 'block', name: 'extra-firm tofu' };

const answerEveryLine = (prompt: string) => ({
  lines: [...prompt.matchAll(/^(\d+)\. .* \| (.+)$/gm)].map(([, number, name]) => ({
    line: Number(number),
    ...parseOf(name!),
  })),
});

describe('parseRecipes', () => {
  it('sends Claude only the lines it has not parsed before, and saves them', async () => {
    const { store, stored } = memoryParsedLines([parsedLine(salt, parseOf('salt'))]);
    const { claude, prompts } = answeringClaude(answerEveryLine);

    const run = await parseRecipes({ claude, parsedLines: store, ingredients: memoryIngredients().store, notes: memoryNotes().store }, household, [recipeWith('soup', [salt, garlic])]);

    expect(run).toMatchObject({ parsed: 1, reused: 1, failed: [], stopped: null });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('1. 2 cloves | garlic');
    expect(prompts[0]).not.toContain('| salt');
    expect(stored.get(lineKey(garlic))?.parse.ingredient).toBe('garlic');
  });

  it('makes no call for a recipe whose lines are all parsed', async () => {
    const { store } = memoryParsedLines([parsedLine(salt, parseOf('salt'))]);
    const { claude, prompts } = answeringClaude(answerEveryLine);

    await parseRecipes({ claude, parsedLines: store, ingredients: memoryIngredients().store, notes: memoryNotes().store }, household, [recipeWith('salted', [salt])]);

    expect(prompts).toEqual([]);
  });

  it('tells Claude the names it already knows, including ones from earlier recipes in the same run', async () => {
    const { store } = memoryParsedLines([parsedLine(salt, parseOf('salt'))]);
    const { claude, prompts } = answeringClaude(answerEveryLine);

    await parseRecipes({ claude, parsedLines: store, ingredients: memoryIngredients().store, notes: memoryNotes().store }, household, [recipeWith('a', [garlic]), recipeWith('b', [tofu])]);

    expect(prompts[1]).toContain('Known ingredient names: garlic; salt');
  });

  it('carries on past a recipe that fails, and reports it', async () => {
    const { store } = memoryParsedLines();
    const { claude } = answeringClaude((prompt) => (prompt.includes('garlic') ? { lines: [] } : answerEveryLine(prompt)));

    const run = await parseRecipes({ claude, parsedLines: store, ingredients: memoryIngredients().store, notes: memoryNotes().store }, household, [recipeWith('a', [garlic]), recipeWith('b', [tofu])]);

    expect(run.parsed).toBe(1);
    expect(run.failed).toEqual([{ recipeId: 'a', reason: expect.stringMatching(/each line exactly once/) }]);
  });

  it('stops at the daily cap and keeps what it parsed so far', async () => {
    const { store, stored } = memoryParsedLines();
    let calls = 0;
    const claude: Claude = {
      ask: async (h, request) => {
        calls += 1;
        if (calls > 1) throw new SpendCapError('Daily cap reached');
        return answeringClaude(answerEveryLine).claude.ask(h, request);
      },
    };

    const run = await parseRecipes({ claude, parsedLines: store, ingredients: memoryIngredients().store, notes: memoryNotes().store }, household, [
      recipeWith('a', [garlic]),
      recipeWith('b', [tofu]),
      recipeWith('c', [salt]),
    ]);

    expect(run).toMatchObject({ parsed: 1, stopped: 'Daily cap reached', failed: [] });
    expect(calls).toBe(2);
    expect(stored.has(lineKey(garlic))).toBe(true);
  });
});

describe('parseRecipes with aliases', () => {
  it("gives a new line the household's name for an alias, in alternatives too", async () => {
    const { store, stored } = memoryParsedLines();
    const { store: ingredients } = memoryIngredients([entry('salt', { aliases: ['kosher salt'] })]);
    const kosher = { amount: 1, unit: 'tsp', name: 'Kosher salt or sea salt' };
    const { claude } = answeringClaude(() => ({
      lines: [{ line: 1, ...parseOf('Kosher Salt', { alternatives: ['sea salt', 'kosher salt'] }) }],
    }));

    await parseRecipes({ claude, parsedLines: store, ingredients, notes: memoryNotes().store }, household, [recipeWith('a', [kosher])]);

    expect(stored.get(lineKey(kosher))?.parse).toMatchObject({ ingredient: 'salt', alternatives: ['sea salt'] });
    expect(stored.get(lineKey(kosher))?.source).toBe('claude');
  });
});

describe('parseRecipes with notes', () => {
  it("gives Claude the household's ingredient notes, and not notes on other topics", async () => {
    const { store } = memoryParsedLines();
    const { store: notes } = memoryNotes([
      note('ingredients.md', 'We cook with broth, not wine.'),
      note('ingredients/oils.md', 'Frying means neutral oil.'),
      note('planning.md', 'No cilantro.'),
    ]);
    const { claude, prompts } = answeringClaude(answerEveryLine);

    await parseRecipes({ claude, parsedLines: store, ingredients: memoryIngredients().store, notes }, household, [
      recipeWith('a', [garlic]),
    ]);

    expect(prompts[0]).toContain(
      'Household rules for turning recipe lines into groceries:\n[ingredients.md]\nWe cook with broth, not wine.\n\n[ingredients/oils.md]\nFrying means neutral oil.\n',
    );
    expect(prompts[0]).not.toContain('cilantro');
  });
});

describe('parseRecipes after a recipe changes', () => {
  const oldOil = { amount: 1.5, unit: 'tbsp', name: 'oil' };
  const newOil = { amount: 2, unit: 'tbsp', name: 'Oil' };

  it("keeps the household's meaning when the same recipe's line changes only its amount", async () => {
    const { store, stored } = memoryParsedLines([parsedLine(oldOil, parseOf('olive oil', { amount: 1.5, unit: 'tbsp' }), 'corrected', ['scram'])]);
    const { claude } = answeringClaude(() => ({ lines: [{ line: 1, ...parseOf('vegetable oil', { amount: 2, unit: 'tbsp', doubt: 'which oil?' }) }] }));

    const run = await parseRecipes({ claude, parsedLines: store, ingredients: memoryIngredients().store, notes: memoryNotes().store }, household, [
      recipeWith('scram', [newOil]),
    ]);

    expect(run.carried).toBe(1);
    expect(stored.get(lineKey(newOil))).toMatchObject({
      source: 'corrected',
      recipeIds: ['scram'],
      parse: { ingredient: 'olive oil', amount: 2, doubt: null },
    });
  });

  it("leaves another recipe's same wording to Claude", async () => {
    const { store, stored } = memoryParsedLines([parsedLine(oldOil, parseOf('olive oil'), 'corrected', ['scram'])]);
    const { claude } = answeringClaude(() => ({ lines: [{ line: 1, ...parseOf('neutral oil', { amount: 2, unit: 'tbsp' }) }] }));

    await parseRecipes({ claude, parsedLines: store, ingredients: memoryIngredients().store, notes: memoryNotes().store }, household, [
      recipeWith('stir-fry', [newOil]),
    ]);

    expect(stored.get(lineKey(newOil))).toMatchObject({ source: 'claude', parse: { ingredient: 'neutral oil' } });
  });

  it('records which recipes use each corrected line, so a later change can find it', async () => {
    const { store, stored } = memoryParsedLines([parsedLine(oldOil, parseOf('olive oil'), 'corrected')]);
    const { claude, prompts } = answeringClaude(answerEveryLine);

    await parseRecipes({ claude, parsedLines: store, ingredients: memoryIngredients().store, notes: memoryNotes().store }, household, [
      recipeWith('scram', [oldOil]),
      recipeWith('hash', [oldOil]),
    ]);

    expect(prompts).toEqual([]);
    expect(stored.get(lineKey(oldOil))?.recipeIds).toEqual(['scram', 'hash']);
  });
});

describe('parseRecipes with reparse', () => {
  it("parses Claude's lines again once each, keeps corrections, and doesn't seed names from the lines being redone", async () => {
    const { store, stored } = memoryParsedLines([
      parsedLine(garlic, parseOf('garlic paste')),
      parsedLine(salt, parseOf('kosher salt'), 'corrected'),
    ]);
    const { claude, prompts } = answeringClaude(answerEveryLine);

    const run = await parseRecipes({ claude, parsedLines: store, ingredients: memoryIngredients().store, notes: memoryNotes().store }, household, [recipeWith('a', [garlic, salt]), recipeWith('b', [garlic])], {
      reparse: true,
    });

    expect(run).toMatchObject({ parsed: 1, reused: 2 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Known ingredient names: kosher salt\n');
    expect(stored.get(lineKey(garlic))?.parse.ingredient).toBe('garlic');
    expect(stored.get(lineKey(salt))?.parse.ingredient).toBe('kosher salt');
  });
});

describe('unsureLines', () => {
  it("lists Claude's doubts once per line, with every recipe that uses it, and skips corrected lines", () => {
    const doubtful = parsedLine(garlic, parseOf('garlic', { doubt: 'clove count is a guess' }));
    const corrected = parsedLine(tofu, parseOf('extra-firm tofu', { doubt: 'size unknown' }), 'corrected');
    const lines = new Map([doubtful, corrected, parsedLine(salt, parseOf('salt'))].map((parsed) => [parsed.key, parsed]));

    expect(unsureLines([recipeWith('a', [garlic, tofu]), recipeWith('b', [garlic, salt])], lines)).toEqual([
      { line: '2 cloves | garlic', recipes: ['Title of a', 'Title of b'], ingredient: 'garlic', doubt: 'clove count is a guess' },
    ]);
  });
});

describe('undecidedIngredients', () => {
  it("lists the recipes' ingredients with no buying decision yet, once each, sorted", () => {
    const lines = new Map(
      [parsedLine(salt, parseOf('salt')), parsedLine(garlic, parseOf('garlic')), parsedLine(tofu, parseOf('extra-firm tofu'))].map(
        (parsed) => [parsed.key, parsed],
      ),
    );
    const entries = [entry('salt', { buying: 'staple' }), entry('garlic')];

    expect(undecidedIngredients([recipeWith('a', [salt, garlic, tofu]), recipeWith('b', [garlic])], lines, entries)).toEqual([
      'extra-firm tofu',
      'garlic',
    ]);
  });
});

describe('withNameCheck', () => {
  const aliasesOf = new Map([['green onion', ['scallion']]]);

  it('leaves a line that names its food alone', () => {
    const parse = parseOf('extra-firm tofu');

    expect(withNameCheck(parse, 'extra firm tofu, pressed', aliasesOf)).toBe(parse);
  });

  it('accepts a line that names one of the food’s aliases', () => {
    expect(withNameCheck(parseOf('green onion'), 'scallions, sliced', aliasesOf).doubt).toBeNull();
  });

  it("asks about a line filed under a food it doesn't name", () => {
    expect(withNameCheck(parseOf('plant-based chicken style bites'), 'breaded vegan chicken nuggets', aliasesOf).doubt).toBe(
      'Filed under "plant-based chicken style bites", which the line doesn\'t name: is it the same food?',
    );
  });

  it("keeps Claude's own doubt and adds the question", () => {
    const parse = parseOf('olive oil', { doubt: 'Guessed the kind of oil.' });

    expect(withNameCheck(parse, 'oil', aliasesOf).doubt).toBe(
      'Guessed the kind of oil. Filed under "olive oil", which the line doesn\'t name: is it the same food?',
    );
  });
});

describe('parseRecipes name check', () => {
  it('marks a new line filed under a food it does not name as unsure', async () => {
    const { store, stored } = memoryParsedLines();
    const nuggets = { amount: 16, unit: 'oz', name: 'breaded vegan chicken nuggets' };
    const { claude } = answeringClaude(() => ({ lines: [{ line: 1, ...parseOf('plant-based chicken style bites') }] }));

    await parseRecipes({ claude, parsedLines: store, ingredients: memoryIngredients().store, notes: memoryNotes().store }, household, [
      recipeWith('a', [nuggets]),
    ]);

    expect(stored.get(lineKey(nuggets))?.parse.doubt).toMatch(/^Filed under "plant-based chicken style bites"/);
  });
});

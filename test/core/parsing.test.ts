import { describe, expect, it } from 'vitest';
import { lineKey } from '../../src/core/ingredient-lines.ts';
import { parseRecipes, unsureLines } from '../../src/core/parsing.ts';
import { SpendCapError, type Claude } from '../../src/llm/claude.ts';
import { answeringClaude, household, memoryParsedLines, parsedLine, parseOf, recipeWith } from '../fakes.ts';

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

    const run = await parseRecipes({ claude, parsedLines: store }, household, [recipeWith('soup', [salt, garlic])]);

    expect(run).toMatchObject({ parsed: 1, reused: 1, failed: [], stopped: null });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('1. 2 cloves | garlic');
    expect(prompts[0]).not.toContain('| salt');
    expect(stored.get(lineKey(garlic))?.parse.ingredient).toBe('garlic');
  });

  it('makes no call for a recipe whose lines are all parsed', async () => {
    const { store } = memoryParsedLines([parsedLine(salt, parseOf('salt'))]);
    const { claude, prompts } = answeringClaude(answerEveryLine);

    await parseRecipes({ claude, parsedLines: store }, household, [recipeWith('salted', [salt])]);

    expect(prompts).toEqual([]);
  });

  it('tells Claude the names it already knows, including ones from earlier recipes in the same run', async () => {
    const { store } = memoryParsedLines([parsedLine(salt, parseOf('salt'))]);
    const { claude, prompts } = answeringClaude(answerEveryLine);

    await parseRecipes({ claude, parsedLines: store }, household, [recipeWith('a', [garlic]), recipeWith('b', [tofu])]);

    expect(prompts[1]).toContain('Known ingredient names: garlic; salt');
  });

  it('carries on past a recipe that fails, and reports it', async () => {
    const { store } = memoryParsedLines();
    const { claude } = answeringClaude((prompt) => (prompt.includes('garlic') ? { lines: [] } : answerEveryLine(prompt)));

    const run = await parseRecipes({ claude, parsedLines: store }, household, [recipeWith('a', [garlic]), recipeWith('b', [tofu])]);

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

    const run = await parseRecipes({ claude, parsedLines: store }, household, [
      recipeWith('a', [garlic]),
      recipeWith('b', [tofu]),
      recipeWith('c', [salt]),
    ]);

    expect(run).toMatchObject({ parsed: 1, stopped: 'Daily cap reached', failed: [] });
    expect(calls).toBe(2);
    expect(stored.has(lineKey(garlic))).toBe(true);
  });
});

describe('parseRecipes with reparse', () => {
  it("parses Claude's lines again once each, keeps corrections, and doesn't seed names from the lines being redone", async () => {
    const { store, stored } = memoryParsedLines([
      parsedLine(garlic, parseOf('garlic paste')),
      parsedLine(salt, parseOf('kosher salt'), 'corrected'),
    ]);
    const { claude, prompts } = answeringClaude(answerEveryLine);

    const run = await parseRecipes({ claude, parsedLines: store }, household, [recipeWith('a', [garlic, salt]), recipeWith('b', [garlic])], {
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

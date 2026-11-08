import { describe, expect, it } from 'vitest';
import { lineKey } from '../../src/core/ingredient-lines.ts';
import { parseLines, parsePrompt } from '../../src/llm/parse-ingredients.ts';
import { answeringClaude, household, parseOf } from '../fakes.ts';

const keyed = (amount: number, unit: string, name: string) => {
  const line = { amount, unit, name };
  return { key: lineKey(line), line };
};

const lines = [keyed(2, 'cloves', 'garlic, minced'), keyed(1, 'can', 'black beans (15oz), drained and rinsed')];

describe('parsePrompt', () => {
  it('numbers the lines and lists the known ingredient names', () => {
    expect(parsePrompt('Tacos', lines, ['garlic', 'salt'])).toBe(
      [
        'Recipe: Tacos',
        'Known ingredient names: garlic; salt',
        'Lines:',
        '1. 2 cloves | garlic, minced',
        '2. 1 can | black beans (15oz), drained and rinsed',
      ].join('\n'),
    );
  });

  it('says when no names are known yet', () => {
    expect(parsePrompt('Tacos', lines, [])).toContain('Known ingredient names: none yet');
  });
});

describe('parseLines', () => {
  it("matches Claude's results to the lines by number, whatever order they come back in", async () => {
    const { claude } = answeringClaude(() => ({
      lines: [
        { line: 2, ...parseOf('canned black beans', { unit: 'can' }) },
        { line: 1, ...parseOf('garlic', { amount: 2, unit: 'clove' }) },
      ],
    }));

    const parsed = await parseLines(claude, household, 'Tacos', lines, []);

    expect(parsed.map(({ line, parse }) => [line.name, parse.ingredient])).toEqual([
      ['garlic, minced', 'garlic'],
      ['black beans (15oz), drained and rinsed', 'canned black beans'],
    ]);
  });

  it.each([
    ['skips a line', [{ line: 1, ...parseOf('garlic') }]],
    [
      'repeats a line',
      [
        { line: 1, ...parseOf('garlic') },
        { line: 1, ...parseOf('garlic') },
      ],
    ],
  ])('refuses an answer that %s', async (_label, answer) => {
    const { claude } = answeringClaude(() => ({ lines: answer }));

    await expect(parseLines(claude, household, 'Tacos', lines, [])).rejects.toThrow(/each line exactly once/);
  });
});

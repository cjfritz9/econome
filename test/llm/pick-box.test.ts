import { describe, expect, it } from 'vitest';
import type { Household } from '../../src/data/household.ts';
import { pickBox, pickPrompt } from '../../src/llm/pick-box.ts';
import { answeringClaude } from '../fakes.ts';

const household: Household = { id: 'h1', name: 'Home', members: ['uid1'], settings: {} };

describe('pickPrompt', () => {
  it('gives Claude the directive, how many recipes the box needs, and one line per candidate', () => {
    expect(pickPrompt('  Maximize protein.\n', 2, [{ id: 'tofu-bowl-1', line: 'Tofu Bowl | 4 | 9' }])).toBe(
      [
        'Planning directive:',
        'Maximize protein.',
        '',
        'Recipes the box still needs: 2',
        '',
        'Candidates (id | name | servings | credits | per serving: kcal, protein, carbs, net carbs (carbs less fiber), sugar, fat, fiber | refined starch, and carbs per serving without it | minutes):',
        'tofu-bowl-1 | Tofu Bowl | 4 | 9',
      ].join('\n'),
    );
  });
});

describe('pickBox', () => {
  it("returns Claude's picks in its order", async () => {
    const { claude } = answeringClaude(() => ({ picks: [{ id: 'b', why: ['30 g protein'] }, { id: 'a', why: [] }] }));

    expect(await pickBox(claude, household, 'Maximize protein.', 3, [])).toEqual([
      { id: 'b', why: ['30 g protein'] },
      { id: 'a', why: [] },
    ]);
  });
});

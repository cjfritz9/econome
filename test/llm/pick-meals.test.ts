import { describe, expect, it } from 'vitest';
import { mealsPrompt } from '../../src/llm/pick-meals.ts';

describe('mealsPrompt', () => {
  it('gives Claude the directive, the people, what is left, the box and one line per recipe', () => {
    const prompt = mealsPrompt('Maximize protein.', { people: 2, left: { breakfast: 0, lunch: 6, dinner: 10 }, box: ['Box Bowl'] }, [
      { id: 'tofu', line: 'Tofu | 4 | quick | 400 kcal, 30 g, 40 g, 12 g, 8 g (complete) | never' },
    ]);

    expect(prompt).toContain('Planning directive:\nMaximize protein.');
    expect(prompt).toContain('People: 2');
    expect(prompt).toContain('Servings still to plan: breakfast 0, lunch 6, dinner 10');
    expect(prompt).toContain("This week's Hungryroot box: Box Bowl");
    expect(prompt).toContain('tofu | Tofu | 4 | quick | 400 kcal, 30 g, 40 g, 12 g, 8 g (complete) | never');
  });
});

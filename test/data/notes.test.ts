import { describe, expect, it } from 'vitest';
import { asRules, NotePath, notesAbout } from '../../src/data/notes.ts';
import { note } from '../fakes.ts';

describe('NotePath', () => {
  it.each(['ingredients.md', 'stores/kroger.md', 'ingredients/oils-and-fats.md'])('accepts %s', (path) => {
    expect(NotePath.safeParse(path).success).toBe(true);
  });

  it.each(['Ingredients.md', 'ingredients', '/ingredients.md', 'stores//kroger.md', 'notes/../secrets.md', 'my notes.md'])(
    'refuses %s',
    (path) => {
      expect(NotePath.safeParse(path).success).toBe(false);
    },
  );
});

describe('notesAbout', () => {
  it("picks the topic's own note and its folder, sorted, and nothing that only starts the same way", () => {
    const notes = [
      note('ingredients/oils.md', 'b'),
      note('ingredients.md', 'a'),
      note('ingredients-old.md', 'c'),
      note('planning.md', 'd'),
    ];

    expect(notesAbout(notes, 'ingredients').map(({ path }) => path)).toEqual(['ingredients.md', 'ingredients/oils.md']);
  });
});

describe('asRules', () => {
  it('labels each note with its path and trims it', () => {
    expect(asRules([note('ingredients.md', '  Broth, not wine.\n'), note('ingredients/oils.md', 'Frying: neutral oil.')])).toBe(
      '[ingredients.md]\nBroth, not wine.\n\n[ingredients/oils.md]\nFrying: neutral oil.',
    );
  });

  it('is empty with no notes', () => {
    expect(asRules([])).toBe('');
  });
});

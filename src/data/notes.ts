import * as z from 'zod';

export const NotePath = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*\.md$/,
    'A note path is lowercase words joined by hyphens, optionally in folders, ending in .md, such as "ingredients.md" or "stores/kroger.md"',
  );

export const NoteContent = z.string().min(1).max(10_000);

export interface Note {
  path: string;
  content: string;
  updatedBy: string;
  updatedAt: string;
}

export interface Notes {
  list: (householdId: string) => Promise<Note[]>;
  save: (householdId: string, note: Omit<Note, 'updatedAt'>) => Promise<void>;
  remove: (householdId: string, path: string) => Promise<void>;
}

export const INGREDIENT_NOTES = 'ingredients';

export const notesAbout = (notes: Note[], topic: string) =>
  notes
    .filter(({ path }) => path === `${topic}.md` || path.startsWith(`${topic}/`))
    .sort((a, b) => a.path.localeCompare(b.path));

export const asRules = (notes: Note[]) => notes.map(({ path, content }) => `[${path}]\n${content.trim()}`).join('\n\n');

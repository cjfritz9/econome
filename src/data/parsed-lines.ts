import * as z from 'zod';
import { formatLine, lineKey, normalizeText } from '../core/ingredient-lines.ts';
import { LineParseSchema, type LineParse } from '../llm/parse-ingredients.ts';

export const ParsedLineSchema = z.object({
  line: z.object({ amount: z.number(), unit: z.string(), name: z.string() }),
  parse: LineParseSchema,
  source: z.enum(['claude', 'corrected']),
  recipeIds: z.array(z.string()).default([]),
});

export type ParsedLine = z.infer<typeof ParsedLineSchema> & { key: string };

const MEANING = ['ingredient', 'alternatives', 'alsoNeeded', 'prep', 'brand', 'optional', 'toTaste', 'measuredAs'] as const;

export const indexByLine = (lines: ParsedLine[]) => {
  const index = new Map<string, ParsedLine>();
  for (const parsed of lines) {
    const key = lineKey(parsed.line);
    const current = index.get(key);
    if (!current || (current.source === 'claude' && parsed.source === 'corrected')) index.set(key, parsed);
  }
  return index;
};

export const meaningsFor = (lines: Iterable<ParsedLine>, recipeId: string) => {
  const meanings = new Map<string, LineParse>();
  for (const { line, parse, source, recipeIds } of lines) {
    if (source === 'corrected' && recipeIds.includes(recipeId)) meanings.set(normalizeText(line.name), parse);
  }
  return meanings;
};

export const withMeaning = (parse: LineParse, meaning: LineParse): LineParse => ({
  ...parse,
  ...Object.fromEntries(MEANING.map((field) => [field, meaning[field]])),
  doubt: null,
});

export const withRecipes = (parsed: ParsedLine, recipeIds: string[]): ParsedLine => ({
  ...parsed,
  recipeIds: [...new Set([...parsed.recipeIds, ...recipeIds])],
});

export interface ParsedLines {
  list: (householdId: string) => Promise<ParsedLine[]>;
  save: (householdId: string, lines: ParsedLine[]) => Promise<void>;
}

export const correctLine = (parsed: ParsedLine, changes: Partial<LineParse>): ParsedLine => ({
  ...parsed,
  parse: LineParseSchema.parse({ ...parsed.parse, ...changes }),
  source: 'corrected',
});

const rename = (names: string[], from: string, to: string) => [...new Set(names.map((name) => (name === from ? to : name)))];

export const renameIngredient = (lines: ParsedLine[], from: string, to: string): ParsedLine[] =>
  lines
    .filter(({ parse }) => [parse.ingredient, ...parse.alternatives, ...parse.alsoNeeded].includes(from))
    .map((parsed) => ({
      ...parsed,
      parse: {
        ...parsed.parse,
        ingredient: parsed.parse.ingredient === from ? to : parsed.parse.ingredient,
        alternatives: rename(parsed.parse.alternatives, from, to),
        alsoNeeded: rename(parsed.parse.alsoNeeded, from, to),
      },
      source: 'corrected',
    }));

export const ingredientIndex = (lines: ParsedLine[]) => {
  const index = new Map<string, string[]>();
  for (const { line, parse } of lines) {
    index.set(parse.ingredient, [...(index.get(parse.ingredient) ?? []), formatLine(line)]);
  }
  return [...index]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ingredient, sourceLines]) => ({ ingredient, lines: sourceLines.sort() }));
};

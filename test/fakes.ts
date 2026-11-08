import { lineKey } from '../src/core/ingredient-lines.ts';
import type { Household } from '../src/data/household.ts';
import type { ParsedLine, ParsedLines } from '../src/data/parsed-lines.ts';
import type { Ingredient, Recipe } from '../src/data/recipes.ts';
import type { Claude } from '../src/llm/claude.ts';
import type { LineParse } from '../src/llm/parse-ingredients.ts';

export const household: Household = { id: 'h1', name: 'Home', members: ['cj'], settings: {} };

export const parseOf = (ingredient: string, overrides: Partial<LineParse> = {}): LineParse => ({
  ingredient,
  amount: 1,
  unit: 'piece',
  packageSize: null,
  measuredAs: null,
  prep: null,
  brand: null,
  alternatives: [],
  alsoNeeded: [],
  optional: false,
  toTaste: false,
  doubt: null,
  ...overrides,
});

export const parsedLine = (line: Ingredient, parse: LineParse, source: ParsedLine['source'] = 'claude'): ParsedLine => ({
  key: lineKey(line),
  line,
  parse,
  source,
});

export const recipeWith = (id: string, lines: Ingredient[]): Recipe => ({
  id,
  title: `Title of ${id}`,
  description: '',
  servings: 2,
  tags: [],
  ingredientGroups: [{ ingredients: lines }],
});

export const memoryParsedLines = (initial: ParsedLine[] = []) => {
  const stored = new Map(initial.map((parsed) => [parsed.key, parsed]));
  const store: ParsedLines = {
    list: async () => [...stored.values()],
    save: async (_householdId, lines) => {
      for (const parsed of lines) stored.set(parsed.key, parsed);
    },
  };
  return { store, stored };
};

export const answeringClaude = (answer: (prompt: string) => unknown) => {
  const prompts: string[] = [];
  const claude: Claude = {
    ask: async (_household, request) => {
      prompts.push(request.prompt);
      return request.schema.parse(answer(request.prompt));
    },
  };
  return { claude, prompts };
};

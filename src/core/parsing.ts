import type { Household } from '../data/household.ts';
import type { ParsedLine, ParsedLines } from '../data/parsed-lines.ts';
import type { Recipe } from '../data/recipes.ts';
import { SpendCapError, type Claude } from '../llm/claude.ts';
import { parseLines } from '../llm/parse-ingredients.ts';
import { logger } from '../logger.ts';
import { formatLine, uniqueLines } from './ingredient-lines.ts';

export interface ParseRun {
  parsed: number;
  reused: number;
  failed: { recipeId: string; reason: string }[];
  stopped: string | null;
  lines: Map<string, ParsedLine>;
}

export const parseRecipes = async (
  { claude, parsedLines }: { claude: Claude; parsedLines: ParsedLines },
  household: Household,
  recipes: Recipe[],
  { reparse = false }: { reparse?: boolean } = {},
): Promise<ParseRun> => {
  const lines = new Map((await parsedLines.list(household.id)).map((parsed) => [parsed.key, parsed]));
  const pending = new Set(
    recipes
      .flatMap((recipe) => uniqueLines(recipe).map(({ key }) => key))
      .filter((key) => !lines.has(key) || (reparse && lines.get(key)?.source === 'claude')),
  );
  const known = new Set(
    [...lines.values()].filter(({ key }) => !pending.has(key)).map(({ parse }) => parse.ingredient),
  );
  const run: ParseRun = { parsed: 0, reused: 0, failed: [], stopped: null, lines };

  for (const recipe of recipes) {
    const recipeLines = uniqueLines(recipe);
    const missing = recipeLines.filter(({ key }) => pending.has(key));
    run.reused += recipeLines.length - missing.length;
    if (missing.length === 0) continue;

    try {
      const parsed = (await parseLines(claude, household, recipe.title, missing, [...known].sort())).map(
        (entry): ParsedLine => ({ ...entry, source: 'claude' }),
      );
      await parsedLines.save(household.id, parsed);
      for (const entry of parsed) {
        lines.set(entry.key, entry);
        pending.delete(entry.key);
        known.add(entry.parse.ingredient);
      }
      run.parsed += parsed.length;
      logger.info({ recipe: recipe.id, lines: parsed.length }, 'Parsed recipe lines');
    } catch (error) {
      if (error instanceof SpendCapError) {
        run.stopped = error.message;
        break;
      }
      run.failed.push({ recipeId: recipe.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return run;
};

export const unsureLines = (recipes: Recipe[], lines: Map<string, ParsedLine>) => {
  const unsure = new Map<string, { line: string; recipes: string[]; ingredient: string; doubt: string }>();
  for (const recipe of recipes) {
    for (const { key } of uniqueLines(recipe)) {
      const parsed = lines.get(key);
      if (!parsed || parsed.source !== 'claude' || !parsed.parse.doubt) continue;
      const entry = unsure.get(key) ?? {
        line: formatLine(parsed.line),
        recipes: [],
        ingredient: parsed.parse.ingredient,
        doubt: parsed.parse.doubt,
      };
      unsure.set(key, { ...entry, recipes: [...entry.recipes, recipe.title] });
    }
  }
  return [...unsure.values()];
};

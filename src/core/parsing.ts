import type { Household } from '../data/household.ts';
import { aliasMap, withAliases, type IngredientEntry, type IngredientRegistry } from '../data/ingredients.ts';
import { asRules, INGREDIENT_NOTES, notesAbout, type Notes } from '../data/notes.ts';
import { indexByLine, meaningsFor, withMeaning, withRecipes, type ParsedLine, type ParsedLines } from '../data/parsed-lines.ts';
import type { Recipe } from '../data/recipes.ts';
import { SpendCapError, type Claude } from '../llm/claude.ts';
import { parseLines, type LineParse } from '../llm/parse-ingredients.ts';
import { logger } from '../logger.ts';
import { formatLine, lineNames, normalizeText, uniqueLines } from './ingredient-lines.ts';

export const withNameCheck = (parse: LineParse, lineName: string, aliasesOf: Map<string, string[]>): LineParse => {
  const names = [parse.ingredient, ...(aliasesOf.get(parse.ingredient) ?? [])];
  if (names.some((name) => lineNames(lineName, name))) return parse;
  const check = `Filed under "${parse.ingredient}", which the line doesn't name: is it the same food?`;
  return { ...parse, doubt: parse.doubt ? `${parse.doubt} ${check}` : check };
};

export interface ParseRun {
  parsed: number;
  reused: number;
  carried: number;
  failed: { recipeId: string; reason: string }[];
  stopped: string | null;
  lines: Map<string, ParsedLine>;
}

export const parseRecipes = async (
  {
    claude,
    parsedLines,
    ingredients,
    notes,
  }: { claude: Claude; parsedLines: ParsedLines; ingredients: IngredientRegistry; notes: Notes },
  household: Household,
  recipes: Recipe[],
  { reparse = false }: { reparse?: boolean } = {},
): Promise<ParseRun> => {
  const [stored, entries, allNotes] = await Promise.all([
    parsedLines.list(household.id),
    ingredients.list(household.id),
    notes.list(household.id),
  ]);
  const rules = asRules(notesAbout(allNotes, INGREDIENT_NOTES));
  const lines = indexByLine(stored);
  const aliases = aliasMap(entries);
  const aliasesOf = new Map(entries.map(({ name, aliases: names }) => [name, names]));

  const stamped = new Map<string, ParsedLine>();
  for (const recipe of recipes) {
    for (const { key } of uniqueLines(recipe)) {
      const parsed = lines.get(key);
      if (parsed?.source !== 'corrected' || parsed.recipeIds.includes(recipe.id)) continue;
      const withRecipe = withRecipes(parsed, [recipe.id]);
      lines.set(key, withRecipe);
      stamped.set(withRecipe.key, withRecipe);
    }
  }
  if (stamped.size > 0) await parsedLines.save(household.id, [...stamped.values()]);

  const pending = new Set(
    recipes
      .flatMap((recipe) => uniqueLines(recipe).map(({ key }) => key))
      .filter((key) => !lines.has(key) || (reparse && lines.get(key)?.source === 'claude')),
  );
  const known = new Set(
    [...lines.values()].filter(({ key }) => !pending.has(key)).map(({ parse }) => parse.ingredient),
  );
  const run: ParseRun = { parsed: 0, reused: 0, carried: 0, failed: [], stopped: null, lines };

  for (const recipe of recipes) {
    const recipeLines = uniqueLines(recipe);
    const missing = recipeLines.filter(({ key }) => pending.has(key));
    run.reused += recipeLines.length - missing.length;
    if (missing.length === 0) continue;

    try {
      const meanings = meaningsFor(lines.values(), recipe.id);
      const parsed = (await parseLines(claude, household, recipe.title, missing, [...known].sort(), rules)).map((entry): ParsedLine => {
        const meaning = meanings.get(normalizeText(entry.line.name));
        return meaning
          ? { ...entry, parse: withAliases(withMeaning(entry.parse, meaning), aliases), source: 'corrected', recipeIds: [recipe.id] }
          : { ...entry, parse: withNameCheck(withAliases(entry.parse, aliases), entry.line.name, aliasesOf), source: 'claude', recipeIds: [] };
      });
      run.carried += parsed.filter(({ source }) => source === 'corrected').length;
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

export const undecidedIngredients = (recipes: Recipe[], lines: Map<string, ParsedLine>, entries: IngredientEntry[]) => {
  const decided = new Set(entries.filter(({ buying }) => buying !== null).map(({ name }) => name));
  const used = recipes.flatMap((recipe) => uniqueLines(recipe).map(({ key }) => lines.get(key)?.parse.ingredient));
  return [...new Set(used)].filter((name): name is string => name !== undefined && !decided.has(name)).sort();
};

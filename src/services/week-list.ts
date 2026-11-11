import { chooseWeek, type CalendarWeek } from '../core/calendar.ts';
import { parseRecipes, unsureLines } from '../core/parsing.ts';
import { buildList, type ShoppingList } from '../core/shopping-list.ts';
import type { Household } from '../data/household.ts';
import type { IngredientEntry, IngredientRegistry } from '../data/ingredients.ts';
import type { Notes } from '../data/notes.ts';
import { indexByLine, type ParsedLines } from '../data/parsed-lines.ts';
import { readLibrary, type Recipes } from '../data/recipes.ts';
import { loadWeeks, type PlannedWeek, type Weeks } from '../data/weeks.ts';
import type { Claude } from '../llm/claude.ts';

export interface ListDeps {
  weeks: Weeks;
  recipes: Recipes;
  parsedLines: ParsedLines;
  ingredients: IngredientRegistry;
  notes: Notes;
  claude: Claude;
}

export interface ListWarning {
  message: string;
  recipeIds: string[];
  line?: string;
}

export interface WeekList {
  week: CalendarWeek;
  planned: PlannedWeek;
  list: Omit<ShoppingList, 'warnings'>;
  warnings: ListWarning[];
  entries: IngredientEntry[];
}

export class NothingPlannedError extends Error {}

export const weekList = async (deps: ListDeps, household: Household, date: string | undefined, { parse }: { parse: boolean }): Promise<WeekList> => {
  const week = chooseWeek(household.settings.timezone, date);
  const [[planned], docs] = await Promise.all([loadWeeks(deps.weeks, household.id, [week]), deps.recipes.listRecipeDocs(household.id)]);
  if (!planned || planned.meals.length === 0) {
    throw new NothingPlannedError(`Nothing from Mise is planned for ${week.id} yet; plan it with plan_week first.`);
  }

  const library = readLibrary(docs);
  const planIds = new Set(planned.meals.map(({ recipeId }) => recipeId));
  const cooked = library.recipes.filter(({ id }) => planIds.has(id));
  const run = parse
    ? await parseRecipes(deps, household, cooked)
    : { stopped: null, failed: [], lines: indexByLine(await deps.parsedLines.list(household.id)) };
  const entries = await deps.ingredients.list(household.id);
  const { warnings: listWarnings, ...list } = buildList(planned.meals, cooked, run.lines, entries, planned.have);

  const titles = new Map(cooked.map(({ id, title }) => [id, title]));
  const idsByTitle = new Map(cooked.map(({ id, title }) => [title, id]));
  const mentioned = (message: string) => cooked.filter(({ title }) => message.includes(title)).map(({ id }) => id);
  const warnings: ListWarning[] = [
    ...(run.stopped ? [{ message: `Parsing stopped: ${run.stopped}`, recipeIds: [] }] : []),
    ...run.failed.map(({ recipeId, reason }) => ({ message: `${titles.get(recipeId) ?? recipeId} couldn't be parsed: ${reason}`, recipeIds: [recipeId] })),
    ...library.skippedLines
      .filter(({ id }) => planIds.has(id))
      .map(({ id, line, reason }) => ({
        message: `${titles.get(id) ?? id}: ${line} was left out of the recipe, to fix in Mise: ${reason}`,
        recipeIds: [id],
        line,
      })),
    ...unsureLines(cooked, run.lines).map(({ line, recipes: inRecipes, ingredient, doubt }) => ({
      message: `Check "${line}" (${inRecipes.join(', ')}), read as ${ingredient}: ${doubt}`,
      recipeIds: inRecipes.flatMap((title) => idsByTitle.get(title) ?? []),
      line,
    })),
    ...listWarnings.map((message) => ({ message, recipeIds: mentioned(message) })),
  ];
  return { week, planned, list, warnings, entries };
};

export const buyListFrom = (deps: ListDeps) => async (household: Household, date: string | undefined) => {
  const { week, list } = await weekList(deps, household, date, { parse: false });
  return { week: week.id, buy: list.buy };
};

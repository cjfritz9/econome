import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { chooseWeek, householdToday, Weekday, weeksEndingWith } from '../core/calendar.ts';
import { formatLine } from '../core/ingredient-lines.ts';
import { parseRecipes, unsureLines } from '../core/parsing.ts';
import type { Decisions } from '../data/decisions.ts';
import { requireHousehold, type Households } from '../data/household.ts';
import { correctLine, ingredientIndex, renameIngredient, type ParsedLines } from '../data/parsed-lines.ts';
import { NOT_A_MEAL_TAG, readLibrary, withTag, type Recipes } from '../data/recipes.ts';
import { SettingsSchema, toUpdatePaths, withDefaults } from '../data/settings.ts';
import { lastPlannedDates, loadWeeks, planMeals, type PlannedWeek, type Weeks } from '../data/weeks.ts';
import type { Claude, SpendLedger } from '../llm/claude.ts';
import { LineParseSchema } from '../llm/parse-ingredients.ts';

export interface ServerDeps {
  households: Households;
  recipes: Recipes;
  weeks: Weeks;
  spend: SpendLedger;
  parsedLines: ParsedLines;
  decisions: Decisions;
  claude: Claude;
  actingUid: string;
}

const LineText = z
  .string()
  .min(1)
  .describe('The line exactly as parse_ingredients or list_ingredients shows it, such as "2 piece | green onions, chopped"');

const RECENT_WEEKS = 13;

const WeekDate = z.iso
  .date()
  .optional()
  .describe(
    'Any date in the week, as YYYY-MM-DD. Weeks run Monday to Sunday. Leave it out for the coming week, the one that starts next Monday.',
  );

const jsonResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

const weekResult = ({ week, meals }: PlannedWeek) => ({ week: week.id, start: week.start, end: week.end, meals });

export const createServer = ({
  households,
  recipes,
  weeks,
  spend,
  parsedLines,
  decisions,
  claude,
  actingUid,
}: ServerDeps) => {
  const server = new McpServer({ name: 'econome', version: '0.5.0' });

  server.registerTool(
    'get_household',
    {
      description:
        "Show the household Économe is working for: its name, its members, Économe's settings, and what Économe has spent on Claude today against its daily cap.",
    },
    async () => {
      const household = await requireHousehold(households, actingUid);
      const settings = withDefaults(household.settings);
      const [members, spentToday] = await Promise.all([
        households.findMemberProfiles(household.members),
        spend.spentOn(household.id, householdToday(settings.timezone, new Date())),
      ]);
      return jsonResult({
        id: household.id,
        name: household.name,
        members,
        settings,
        claudeSpendToday: { usd: Number(spentToday.toFixed(4)), cap: settings.dailyClaudeCapUsd },
      });
    },
  );

  server.registerTool(
    'update_settings',
    {
      description:
        "Change Économe's household settings. Only the fields given are changed; everything else is left as it is.",
      inputSchema: SettingsSchema,
    },
    async (changes) => {
      const household = await requireHousehold(households, actingUid);
      const paths = toUpdatePaths(changes);
      if (Object.keys(paths).length === 0) throw new Error('No settings were given to change.');

      await households.updateSettings(household.id, paths);
      const updated = await requireHousehold(households, actingUid);
      return jsonResult(withDefaults(updated.settings));
    },
  );

  server.registerTool(
    'list_recipes',
    {
      description: `List the household's Mise recipes that can be planned: id, title, description, servings and tags, plus lastPlanned, the Monday of the latest week it was planned for (looking back ${RECENT_WEEKS - 1} weeks). Archived recipes and anything tagged ${NOT_A_MEAL_TAG} are left out. Recipes Économe can't use are listed under "skipped" with the reason, to be fixed in Mise.`,
      inputSchema: z.object({
        tag: z.string().optional().describe('Only list recipes with this tag, in any letter case'),
      }),
    },
    async ({ tag }) => {
      const household = await requireHousehold(households, actingUid);
      const recent = weeksEndingWith(chooseWeek(household.settings.timezone, undefined), RECENT_WEEKS);
      const [docs, planned] = await Promise.all([
        recipes.listRecipeDocs(household.id),
        loadWeeks(weeks, household.id, recent),
      ]);
      const library = readLibrary(docs);
      const lastPlanned = lastPlannedDates(planned);
      const listed = tag ? withTag(library.recipes, tag) : library.recipes;
      return jsonResult({
        recipes: listed.map(({ id, title, description, servings, tags }) => {
          const last = lastPlanned.get(id);
          return { id, title, description, servings, tags, ...(last && { lastPlanned: last }) };
        }),
        ...(library.skipped.length > 0 && { skipped: library.skipped }),
      });
    },
  );

  server.registerTool(
    'plan_week',
    {
      description:
        "Save a week's meals, replacing whatever was planned for that week before, so send every meal each time. Each meal is a recipe id from list_recipes, with the servings to cook and optionally a day.",
      inputSchema: z.object({
        week: WeekDate,
        meals: z
          .array(
            z.object({
              recipeId: z.string().min(1).describe('A recipe id from list_recipes'),
              servings: z.number().positive().optional().describe("Servings to cook; the recipe's own if left out"),
              day: Weekday.optional().describe("The day it's planned for, if any"),
            }),
          )
          .describe('Every meal for the week'),
      }),
    },
    async ({ week: date, meals: requests }) => {
      const household = await requireHousehold(households, actingUid);
      const week = chooseWeek(household.settings.timezone, date);
      const library = readLibrary(await recipes.listRecipeDocs(household.id));
      const meals = planMeals(library.recipes, requests);
      await weeks.saveMeals(household.id, week.id, meals, actingUid);
      return jsonResult(weekResult({ week, meals }));
    },
  );

  server.registerTool(
    'get_week',
    {
      description: "Show a week's planned meals.",
      inputSchema: z.object({ week: WeekDate }),
    },
    async ({ week: date }) => {
      const household = await requireHousehold(households, actingUid);
      const week = chooseWeek(household.settings.timezone, date);
      const [planned = { week, meals: [] }] = await loadWeeks(weeks, household.id, [week]);
      return jsonResult(weekResult(planned));
    },
  );

  server.registerTool(
    'parse_ingredients',
    {
      description:
        "Have Claude parse the ingredient lines of the household's recipes: the food to buy, amount, unit, package size, prep, brand, alternatives, and whether it's optional. Lines parsed before are reused, so only new or changed lines cost anything. Returns a summary and the lines Claude was unsure about, to review with the household and fix with correct_ingredient_line.",
      inputSchema: z.object({
        recipeIds: z.array(z.string()).optional().describe('Only these recipes; every plannable recipe if left out'),
        reparse: z
          .boolean()
          .optional()
          .describe("Parse again the lines Claude parsed before, such as after the parser improves. The household's corrections are kept."),
      }),
    },
    async ({ recipeIds, reparse }) => {
      const household = await requireHousehold(households, actingUid);
      const library = readLibrary(await recipes.listRecipeDocs(household.id));
      const chosen = recipeIds ? library.recipes.filter((recipe) => recipeIds.includes(recipe.id)) : library.recipes;
      const unknown = (recipeIds ?? []).filter((id) => !chosen.some((recipe) => recipe.id === id));
      if (unknown.length > 0) throw new Error(`No plannable recipe has these ids: ${unknown.join(', ')}.`);

      const run = await parseRecipes({ claude, parsedLines }, household, chosen, { reparse });
      return jsonResult({
        parsed: run.parsed,
        reused: run.reused,
        ...(run.stopped && { stopped: run.stopped }),
        ...(run.failed.length > 0 && { failed: run.failed }),
        unsure: unsureLines(chosen, run.lines),
      });
    },
  );

  server.registerTool(
    'list_ingredients',
    {
      description:
        'List every ingredient name parsed out of the recipes, with the recipe lines behind each, to spot duplicates such as "scallion" and "green onion" and merge them with rename_ingredient.',
    },
    async () => {
      const household = await requireHousehold(households, actingUid);
      return jsonResult(ingredientIndex(await parsedLines.list(household.id)));
    },
  );

  server.registerTool(
    'correct_ingredient_line',
    {
      description:
        "Fix how one recipe line was parsed. Only the fields given change. The household's correction is kept, used from then on, and saved as a decision.",
      inputSchema: z.object({ line: LineText, changes: LineParseSchema.partial() }),
    },
    async ({ line, changes }) => {
      const household = await requireHousehold(households, actingUid);
      const target = (await parsedLines.list(household.id)).find((parsed) => formatLine(parsed.line) === line);
      if (!target) throw new Error(`No parsed line reads "${line}". Copy it exactly from parse_ingredients or list_ingredients.`);

      const corrected = correctLine(target, changes);
      await parsedLines.save(household.id, [corrected]);
      await decisions.record(household.id, {
        kind: 'parse-correction',
        input: target.line,
        suggestion: target.parse,
        answer: corrected.parse,
        by: actingUid,
      });
      return jsonResult({ line, parse: corrected.parse });
    },
  );

  server.registerTool(
    'rename_ingredient',
    {
      description:
        'Rename an ingredient everywhere it was parsed, including where it appears as an alternative, to merge duplicates such as "scallion" into "green onion". Saved as a decision.',
      inputSchema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
    },
    async ({ from, to }) => {
      const household = await requireHousehold(households, actingUid);
      const renamed = renameIngredient(await parsedLines.list(household.id), from, to);
      if (renamed.length === 0) throw new Error(`No parsed line uses "${from}". Check list_ingredients for the exact name.`);

      await parsedLines.save(household.id, renamed);
      await decisions.record(household.id, {
        kind: 'ingredient-rename',
        input: renamed.map(({ line }) => formatLine(line)),
        suggestion: from,
        answer: to,
        by: actingUid,
      });
      return jsonResult({ renamed: renamed.length, from, to });
    },
  );

  return server;
};

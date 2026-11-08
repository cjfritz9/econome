import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { chooseWeek, householdToday, Weekday, weeksEndingWith } from '../core/calendar.ts';
import { requireHousehold, type Households } from '../data/household.ts';
import { NOT_A_MEAL_TAG, readLibrary, withTag, type Recipes } from '../data/recipes.ts';
import { SettingsSchema, toUpdatePaths, withDefaults } from '../data/settings.ts';
import { lastPlannedDates, loadWeeks, planMeals, type PlannedWeek, type Weeks } from '../data/weeks.ts';
import type { SpendLedger } from '../llm/claude.ts';

export interface ServerDeps {
  households: Households;
  recipes: Recipes;
  weeks: Weeks;
  spend: SpendLedger;
  actingUid: string;
}

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

export const createServer = ({ households, recipes, weeks, spend, actingUid }: ServerDeps) => {
  const server = new McpServer({ name: 'econome', version: '0.4.0' });

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

  return server;
};

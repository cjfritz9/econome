import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { chooseWeek, householdToday, Weekday, weeksEndingWith } from '../core/calendar.ts';
import { formatLine } from '../core/ingredient-lines.ts';
import { parseRecipes, undecidedIngredients, unsureLines } from '../core/parsing.ts';
import type { Decisions } from '../data/decisions.ts';
import { requireHousehold, type Households } from '../data/household.ts';
import {
  addAlias,
  BUYING,
  describeIngredients,
  normalizeName,
  removeAlias,
  setBuying,
  type IngredientRegistry,
} from '../data/ingredients.ts';
import { INGREDIENT_NOTES, NoteContent, NotePath, type Notes } from '../data/notes.ts';
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
  ingredients: IngredientRegistry;
  notes: Notes;
  decisions: Decisions;
  claude: Claude;
  actingUid: string;
}

const LineText = z
  .string()
  .min(1)
  .describe('The line exactly as parse_ingredients or list_ingredients shows it, such as "2 piece | green onions, chopped"');

const RECENT_WEEKS = 13;

const INSTRUCTIONS = `Économe plans the household's week from its Mise recipes and turns the recipes into a shopping list. It learns from the household: whenever it judges something on its own, such as how a recipe line was parsed, which ingredient names are the same food, or how an ingredient is bought, the household can correct it with a tool, and the correction is kept and saved as a decision.

When something looks wrong or unclear, such as a line that doesn't say what to buy, two names that might be the same food, or an ingredient whose buying is undecided, ask the household before deciding. Then record the answer with the matching tool: correct_ingredient_line for one line, rename_ingredient to merge two names (new recipes follow it too), and set_buying for weekly, staple or never bought. A rule that fits none of them, such as "we cook with broth, not wine", goes in a note with write_note. Never treat two foods as the same without asking.

A recipe's ingredient list is the source of truth, and Économe never reads its steps. When a line in a recipe is itself wrong or vague, suggest fixing it in Mise, so the recipe is right for whoever cooks it.

Read the notes with read_notes before planning a week or settling an ingredient question.`;

const IngredientNames = z
  .array(z.string().min(1))
  .min(1)
  .describe('Ingredient names exactly as list_ingredients shows them');

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
  ingredients,
  notes,
  decisions,
  claude,
  actingUid,
}: ServerDeps) => {
  const server = new McpServer({ name: 'econome', version: '0.7.0' }, { instructions: INSTRUCTIONS });

  const loadIngredients = async (householdId: string) => {
    const [lines, entries] = await Promise.all([parsedLines.list(householdId), ingredients.list(householdId)]);
    const known = new Set([...lines.map(({ parse }) => parse.ingredient), ...entries.map(({ name }) => name)]);
    return { lines, entries, known };
  };

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
        "Have Claude parse the ingredient lines of the household's recipes: the food to buy, amount, unit, package size, prep, brand, alternatives, and whether it's optional. Lines parsed before are reused, so only new or changed lines cost anything. New lines follow the household's aliases and its ingredient notes; use reparse to apply a new note to lines Claude parsed before. Returns a summary, the lines Claude was unsure about (to review with the household and fix with correct_ingredient_line), and the ingredients whose buying isn't decided yet (to settle with set_buying).",
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

      const run = await parseRecipes({ claude, parsedLines, ingredients, notes }, household, chosen, { reparse });
      const undecided = undecidedIngredients(chosen, run.lines, await ingredients.list(household.id));
      return jsonResult({
        parsed: run.parsed,
        reused: run.reused,
        ...(run.stopped && { stopped: run.stopped }),
        ...(run.failed.length > 0 && { failed: run.failed }),
        unsure: unsureLines(chosen, run.lines),
        ...(undecided.length > 0 && { undecided }),
      });
    },
  );

  server.registerTool(
    'list_ingredients',
    {
      description:
        'List every ingredient name parsed out of the recipes, with how it\'s bought (weekly, staple, never or undecided), its aliases, and the recipe lines behind it. Use it to spot duplicates such as "scallion" and "green onion" and merge them with rename_ingredient.',
      inputSchema: z.object({
        only: z
          .enum(['undecided', ...BUYING])
          .optional()
          .describe('Only ingredients bought this way, or "undecided" for the ones not settled yet'),
      }),
    },
    async ({ only }) => {
      const household = await requireHousehold(households, actingUid);
      const { lines, entries } = await loadIngredients(household.id);
      const described = describeIngredients(ingredientIndex(lines), entries);
      return jsonResult(only ? described.filter(({ buying }) => buying === only) : described);
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
        'Rename an ingredient everywhere it was parsed, including where it appears as an alternative, to merge duplicates such as "scallion" into "green onion". The old name becomes an alias, so new recipes that say it get the new name too. With no line using the old name yet, it only adds the alias, as long as the new name is a known ingredient. Saved as a decision.',
      inputSchema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
    },
    async ({ from, to }) => {
      const household = await requireHousehold(households, actingUid);
      const { lines, entries, known } = await loadIngredients(household.id);
      const renamed = renameIngredient(lines, from, to);
      if (renamed.length === 0 && !known.has(to)) {
        throw new Error(`No parsed line uses "${from}", and "${to}" isn't a known ingredient. Check list_ingredients for the exact names.`);
      }

      const { saved, removedIds } = addAlias(entries, from, to);
      await parsedLines.save(household.id, renamed);
      await ingredients.save(household.id, saved);
      await ingredients.remove(household.id, removedIds);
      await decisions.record(household.id, {
        kind: 'ingredient-rename',
        input: renamed.map(({ line }) => formatLine(line)),
        suggestion: from,
        answer: to,
        by: actingUid,
      });
      return jsonResult({ renamed: renamed.length, from, to, alias: normalizeName(from) });
    },
  );

  server.registerTool(
    'remove_alias',
    {
      description:
        "Stop treating a name as another ingredient in new recipes. Lines already merged under the other name stay as they are; fix those one at a time with correct_ingredient_line. Saved as a decision.",
      inputSchema: z.object({ alias: z.string().min(1).describe('The alias as list_ingredients shows it') }),
    },
    async ({ alias }) => {
      const household = await requireHousehold(households, actingUid);
      const updated = removeAlias(await ingredients.list(household.id), alias);
      await ingredients.save(household.id, [updated]);
      await decisions.record(household.id, {
        kind: 'alias-removal',
        input: normalizeName(alias),
        suggestion: updated.name,
        answer: null,
        by: actingUid,
      });
      return jsonResult({ removed: normalizeName(alias), from: updated.name });
    },
  );

  server.registerTool(
    'set_buying',
    {
      description:
        'Say how ingredients are bought. "weekly": bought for the recipes that need it. "staple": usually on hand and not bought every week, so the list asks before buying it. "never": never bought on its own, like water, or because it comes with another ingredient, like adobo sauce from the can of chipotle peppers. Saved as a decision.',
      inputSchema: z.object({
        names: IngredientNames,
        buying: z.enum(BUYING),
        comesWith: z
          .string()
          .min(1)
          .optional()
          .describe('Only with "never": the ingredient it comes with, as list_ingredients shows it'),
      }),
    },
    async ({ names, buying, comesWith }) => {
      const household = await requireHousehold(households, actingUid);
      const { entries, known } = await loadIngredients(household.id);
      const unknown = [...names, ...(comesWith ? [comesWith] : [])].filter((name) => !known.has(name));
      if (unknown.length > 0) throw new Error(`Not known ingredients: ${unknown.join(', ')}. Check list_ingredients for the exact names.`);
      if (comesWith && buying !== 'never') throw new Error('comesWith only goes with "never".');

      const saved = setBuying(entries, names, buying, comesWith ?? null);
      await ingredients.save(household.id, saved);
      await decisions.record(household.id, {
        kind: 'ingredient-buying',
        input: saved.map(({ name }) => name),
        suggestion: Object.fromEntries(saved.map(({ name }) => [name, entries.find((entry) => entry.name === name)?.buying ?? null])),
        answer: { buying, comesWith: comesWith ?? null },
        by: actingUid,
      });
      return jsonResult({ buying, ...(comesWith && { comesWith }), names: saved.map(({ name }) => name) });
    },
  );

  server.registerTool(
    'read_notes',
    {
      description:
        "Read the household's notes: long-term rules and facts that don't fit a tool, such as \"no cilantro for Jeana\" or \"we cook with broth, not wine\". Without a path, returns every note.",
      inputSchema: z.object({ path: NotePath.optional().describe('One note, such as "ingredients.md"') }),
    },
    async ({ path }) => {
      const household = await requireHousehold(households, actingUid);
      const all = (await notes.list(household.id)).sort((a, b) => a.path.localeCompare(b.path));
      if (!path) return jsonResult(all);
      const note = all.find((candidate) => candidate.path === path);
      if (!note) throw new Error(`No note at "${path}". Notes: ${all.map((candidate) => candidate.path).join(', ') || 'none yet'}.`);
      return jsonResult(note);
    },
  );

  server.registerTool(
    'write_note',
    {
      description: `Create or replace a household note. It replaces the whole note, so read it first and send the full text. Notes in ${INGREDIENT_NOTES}.md or under ${INGREDIENT_NOTES}/ are rules for turning recipe lines into groceries, and the parser follows them for new lines. Other topics get their own path, such as planning.md or stores/kroger.md. Saved as a decision.`,
      inputSchema: z.object({ path: NotePath, content: NoteContent }),
    },
    async ({ path, content }) => {
      const household = await requireHousehold(households, actingUid);
      const previous = (await notes.list(household.id)).find((note) => note.path === path);
      await notes.save(household.id, { path, content, updatedBy: actingUid });
      await decisions.record(household.id, {
        kind: 'note-write',
        input: path,
        suggestion: previous?.content ?? null,
        answer: content,
        by: actingUid,
      });
      return jsonResult({ path, created: !previous });
    },
  );

  server.registerTool(
    'delete_note',
    {
      description: 'Delete a household note. Its last text is kept in the decision record.',
      inputSchema: z.object({ path: NotePath }),
    },
    async ({ path }) => {
      const household = await requireHousehold(households, actingUid);
      const previous = (await notes.list(household.id)).find((note) => note.path === path);
      if (!previous) throw new Error(`No note at "${path}".`);
      await notes.remove(household.id, path);
      await decisions.record(household.id, {
        kind: 'note-delete',
        input: path,
        suggestion: previous.content,
        answer: null,
        by: actingUid,
      });
      return jsonResult({ deleted: path });
    },
  );

  return server;
};

import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { chooseWeek, householdToday, Weekday, weeksEndingWith } from '../core/calendar.ts';
import { matchFoods } from '../core/food-matching.ts';
import { recipeNutrition } from '../core/nutrition.ts';
import { formatLine, normalizeText, recipesWithLine } from '../core/ingredient-lines.ts';
import { parseRecipes, undecidedIngredients, unsureLines } from '../core/parsing.ts';
import { ECONOME_FEATURE, requireFeature, type Access } from '../data/access.ts';
import type { Decisions } from '../data/decisions.ts';
import { requireHousehold, type Households } from '../data/household.ts';
import {
  addAlias,
  BUYING,
  describeIngredients,
  describeWeights,
  normalizeName,
  removeAlias,
  setBuying,
  withFdcQuery,
  withFood,
  withUnitWeight,
  type IngredientRegistry,
} from '../data/ingredients.ts';
import { INGREDIENT_NOTES, NoteContent, NotePath, type Notes } from '../data/notes.ts';
import { correctLine, indexByLine, ingredientIndex, renameIngredient, withRecipes, type ParsedLines } from '../data/parsed-lines.ts';
import { NOT_A_MEAL_TAG, readLibrary, withTag, type Recipes } from '../data/recipes.ts';
import { SettingsSchema, toUpdatePaths, withDefaults } from '../data/settings.ts';
import { lastPlannedDates, loadWeeks, planMeals, type PlannedWeek, type Weeks } from '../data/weeks.ts';
import type { Claude, SpendLedger } from '../llm/claude.ts';
import { LineParseSchema, UNITS } from '../llm/parse-ingredients.ts';
import type { FoodData } from '../sources/fdc.ts';

export interface ServerDeps {
  access: Access;
  households: Households;
  recipes: Recipes;
  weeks: Weeks;
  spend: SpendLedger;
  parsedLines: ParsedLines;
  ingredients: IngredientRegistry;
  notes: Notes;
  fdc: FoodData;
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

Read the notes with read_notes before planning a week or settling an ingredient question. Planning and recipe suggestions follow the household's planning directive, the note get_household names as settings.planningDirective. It's always in effect; the household changes it by editing that note with write_note, or swaps it by pointing planningDirective at another note under directives/ with update_settings. Suggested swaps must make sense in the dish, and are only suggestions until someone says yes.

Nutrition is an estimate: each ingredient is matched once to a USDA FoodData Central food with match_foods. A wrong match is fixed with search_foods and set_food, a name FoodData Central spells differently (lemongrass as "lemon grass") with set_food_search, and a wrong weight (one cup, one piece, one can) with set_unit_weight.`;

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
  access,
  households,
  recipes,
  weeks,
  spend,
  parsedLines,
  ingredients,
  notes,
  fdc,
  decisions,
  claude,
  actingUid,
}: ServerDeps) => {
  const server = new McpServer({ name: 'econome', version: '0.12.0' }, { instructions: INSTRUCTIONS });

  const member = async () => {
    await requireFeature(access, actingUid, ECONOME_FEATURE);
    return requireHousehold(households, actingUid);
  };

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
      const household = await member();
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
      const household = await member();
      const paths = toUpdatePaths(changes);
      if (Object.keys(paths).length === 0) throw new Error('No settings were given to change.');

      await households.updateSettings(household.id, paths);
      const updated = await member();
      return jsonResult(withDefaults(updated.settings));
    },
  );

  server.registerTool(
    'list_recipes',
    {
      description: `List the household's Mise recipes that can be planned: id, title, description, servings and tags, plus lastPlanned, the Monday of the latest week it was planned for (looking back ${RECENT_WEEKS - 1} weeks). Each recipe has its estimated nutrition per serving (calories, and grams of protein, carbs, sugar, fiber and fat) from USDA FoodData Central, with nutritionGaps naming lines left out of the estimate and why, and nutrientsMissing naming ingredients whose FoodData Central food has no value for a nutrient, so that nutrient is undercounted. Archived recipes and anything tagged ${NOT_A_MEAL_TAG} are left out. Recipes Économe can't use are listed under "skipped" with the reason, and lines it left out of a recipe it still uses under "skippedLines", both to be fixed in Mise.`,
      inputSchema: z.object({
        tag: z.string().optional().describe('Only list recipes with this tag, in any letter case'),
        minProtein: z.number().nonnegative().optional().describe('Only recipes with at least this many grams of protein per serving'),
        maxCarbs: z.number().nonnegative().optional().describe('Only recipes with at most this many grams of carbs per serving'),
        maxSugar: z.number().nonnegative().optional().describe('Only recipes with at most this many grams of sugar per serving'),
      }),
    },
    async ({ tag, minProtein, maxCarbs, maxSugar }) => {
      const household = await member();
      const recent = weeksEndingWith(chooseWeek(household.settings.timezone, undefined), RECENT_WEEKS);
      const [docs, planned, lines, entries] = await Promise.all([
        recipes.listRecipeDocs(household.id),
        loadWeeks(weeks, household.id, recent),
        parsedLines.list(household.id),
        ingredients.list(household.id),
      ]);
      const library = readLibrary(docs);
      const lastPlanned = lastPlannedDates(planned);
      const byKey = indexByLine(lines);
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      const filtered = minProtein !== undefined || maxCarbs !== undefined || maxSugar !== undefined;

      const listed = (tag ? withTag(library.recipes, tag) : library.recipes).flatMap((recipe) => {
        const { perServing, gaps, missing } = recipeNutrition(recipe, byKey, byName);
        const fits =
          perServing !== null &&
          perServing.protein >= (minProtein ?? 0) &&
          perServing.carbs <= (maxCarbs ?? Infinity) &&
          perServing.sugar <= (maxSugar ?? Infinity);
        if (filtered && !fits) return [];
        const { id, title, description, servings, tags } = recipe;
        const last = lastPlanned.get(id);
        return [
          {
            id,
            title,
            description,
            servings,
            tags,
            ...(last && { lastPlanned: last }),
            nutritionPerServing: perServing ?? 'not estimated yet',
            ...(perServing && gaps.length > 0 && { nutritionGaps: gaps }),
            ...(perServing && missing.length > 0 && { nutrientsMissing: missing }),
          },
        ];
      });
      return jsonResult({
        recipes: listed,
        ...(library.skipped.length > 0 && { skipped: library.skipped }),
        ...(library.skippedLines.length > 0 && { skippedLines: library.skippedLines }),
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
      const household = await member();
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
      const household = await member();
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
      const household = await member();
      const library = readLibrary(await recipes.listRecipeDocs(household.id));
      const chosen = recipeIds ? library.recipes.filter((recipe) => recipeIds.includes(recipe.id)) : library.recipes;
      const unknown = (recipeIds ?? []).filter((id) => !chosen.some((recipe) => recipe.id === id));
      if (unknown.length > 0) throw new Error(`No plannable recipe has these ids: ${unknown.join(', ')}.`);

      const run = await parseRecipes({ claude, parsedLines, ingredients, notes }, household, chosen, { reparse });
      const undecided = undecidedIngredients(chosen, run.lines, await ingredients.list(household.id));
      return jsonResult({
        parsed: run.parsed,
        reused: run.reused,
        ...(run.carried > 0 && { keptCorrections: run.carried }),
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
          .enum(['undecided', 'unmatched', ...BUYING])
          .optional()
          .describe(
            'Only ingredients bought this way, "undecided" for the ones whose buying isn\'t settled, or "unmatched" for the ones with no FoodData Central food yet',
          ),
      }),
    },
    async ({ only }) => {
      const household = await member();
      const { lines, entries } = await loadIngredients(household.id);
      const described = describeIngredients(ingredientIndex(lines), entries);
      if (only === 'unmatched') return jsonResult(described.filter((ingredient) => !('food' in ingredient)));
      return jsonResult(only ? described.filter(({ buying }) => buying === only) : described);
    },
  );

  server.registerTool(
    'correct_ingredient_line',
    {
      description:
        "Fix how one recipe line was parsed. Only the fields given change. The household's correction is kept, used from then on, and saved as a decision. What the line means (the food, alternatives, prep, brand, optional) also carries over when the same recipe's line later changes only its amount or unit.",
      inputSchema: z.object({ line: LineText, changes: LineParseSchema.partial() }),
    },
    async ({ line, changes }) => {
      const household = await member();
      const [stored, docs] = await Promise.all([parsedLines.list(household.id), recipes.listRecipeDocs(household.id)]);
      const target = stored.find((parsed) => normalizeText(formatLine(parsed.line)) === normalizeText(line));
      if (!target) throw new Error(`No parsed line reads "${line}". Copy it from parse_ingredients or list_ingredients.`);

      const corrected = withRecipes(correctLine(target, changes), recipesWithLine(readLibrary(docs).recipes, target.line));
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
      const household = await member();
      const [{ lines, entries, known }, docs] = await Promise.all([loadIngredients(household.id), recipes.listRecipeDocs(household.id)]);
      const library = readLibrary(docs).recipes;
      const renamed = renameIngredient(lines, from, to).map((parsed) => withRecipes(parsed, recipesWithLine(library, parsed.line)));
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
      const household = await member();
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
      const household = await member();
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
    'match_foods',
    {
      description:
        "Match ingredients to USDA FoodData Central foods for nutrition estimates, and estimate their weights (grams per cup, per piece, per can) from how the household's lines use them. Each ingredient is matched once and kept; Claude Haiku picks among FoodData Central's search results. Works through the unmatched ingredients a batch at a time and says how many remain. Returns the matches Claude was unsure about and the ingredients with no fitting food, to review with the household.",
      inputSchema: z.object({
        ingredients: IngredientNames.optional().describe('Only these ingredients; every unmatched one if left out'),
        rematch: z.boolean().optional().describe("Match again the ones Claude matched before. The household's choices are kept."),
        limit: z.number().int().min(1).max(50).optional().describe('How many to match in this call; 25 if left out'),
      }),
    },
    async ({ ingredients: names, rematch, limit }) => {
      const household = await member();
      if (names) {
        const { known } = await loadIngredients(household.id);
        const unknown = names.filter((name) => !known.has(name));
        if (unknown.length > 0) throw new Error(`Not known ingredients: ${unknown.join(', ')}. Check list_ingredients for the exact names.`);
      }
      const run = await matchFoods({ claude, fdc, ingredients, parsedLines }, household, {
        ...(names && { names }),
        rematch: rematch ?? false,
        limit: limit ?? 25,
      });
      return jsonResult({
        matched: run.matched,
        remaining: run.remaining,
        ...(run.stopped && { stopped: run.stopped }),
        ...(run.failed.length > 0 && { failed: run.failed }),
        unsure: run.unsure,
        noFood: run.noFood,
      });
    },
  );

  server.registerTool(
    'search_foods',
    {
      description:
        'Search USDA FoodData Central, to find a better food for an ingredient than the one match_foods chose. Returns each food\'s fdcId, description, data type, nutrition per 100 g and household portions; pass the fdcId to set_food.',
      inputSchema: z.object({ query: z.string().min(1).describe('What to search for, such as "tofu extra firm"') }),
    },
    async ({ query }) => jsonResult(await fdc.candidates(query)),
  );

  server.registerTool(
    'set_food',
    {
      description:
        "Choose the USDA FoodData Central food for an ingredient, by its fdcId from search_foods, or null when no food fits and the ingredient should stay out of nutrition estimates. The household's choice is kept, used from then on, and saved as a decision.",
      inputSchema: z.object({
        ingredient: z.string().min(1).describe('The ingredient as list_ingredients shows it'),
        fdcId: z.number().int().positive().nullable(),
      }),
    },
    async ({ ingredient, fdcId }) => {
      const household = await member();
      const { entries, known } = await loadIngredients(household.id);
      if (!known.has(ingredient)) throw new Error(`"${ingredient}" isn't a known ingredient. Check list_ingredients for the exact name.`);
      const chosen = fdcId === null ? null : await fdc.food(fdcId);
      if (fdcId !== null && !chosen) throw new Error(`FoodData Central has no food ${fdcId}.`);

      const previous = entries.find((entry) => entry.name === ingredient)?.food ?? null;
      const saved = withFood(entries, ingredient, {
        fdcId: chosen?.fdcId ?? null,
        description: chosen?.description ?? null,
        per100g: chosen?.per100g ?? null,
        source: 'corrected',
        doubt: null,
      });
      await ingredients.save(household.id, [saved]);
      await decisions.record(household.id, {
        kind: 'food-match',
        input: ingredient,
        suggestion: previous && { fdcId: previous.fdcId, description: previous.description },
        answer: chosen && { fdcId: chosen.fdcId, description: chosen.description },
        by: actingUid,
      });
      return jsonResult({ ingredient, food: saved.food?.description ?? 'no FoodData Central food', per100g: saved.food?.per100g ?? null });
    },
  );

  server.registerTool(
    'set_food_search',
    {
      description:
        'Teach Économe what to search FoodData Central for when an ingredient\'s own name finds the wrong foods or none, such as "lemon grass" for lemongrass. The search term is kept for every later match and saved as a decision, and the ingredient is matched again with it now, unless the household already chose its food with set_food.',
      inputSchema: z.object({
        ingredient: z.string().min(1).describe('The ingredient as list_ingredients shows it'),
        query: z.string().min(1).describe('What to search FoodData Central for'),
      }),
    },
    async ({ ingredient, query }) => {
      const household = await member();
      const { entries, known } = await loadIngredients(household.id);
      if (!known.has(ingredient)) throw new Error(`"${ingredient}" isn't a known ingredient. Check list_ingredients for the exact name.`);
      const previous = entries.find((entry) => entry.name === ingredient);
      const saved = withFdcQuery(entries, ingredient, query);
      await ingredients.save(household.id, [saved]);
      await decisions.record(household.id, {
        kind: 'food-search',
        input: ingredient,
        suggestion: previous?.fdcQuery ?? ingredient,
        answer: saved.fdcQuery,
        by: actingUid,
      });
      if (saved.food?.source === 'corrected') {
        return jsonResult({ ingredient, searchAs: saved.fdcQuery, food: saved.food.description, kept: 'the food the household chose' });
      }

      const run = await matchFoods({ claude, fdc, ingredients, parsedLines }, household, { names: [ingredient], rematch: true, limit: 1 });
      const matched = (await ingredients.list(household.id)).find((entry) => entry.name === ingredient);
      return jsonResult({
        ingredient,
        searchAs: saved.fdcQuery,
        food: matched?.food?.description ?? 'no FoodData Central food',
        ...(run.stopped && { stopped: run.stopped }),
        ...(run.failed.length > 0 && { failed: run.failed }),
        ...(matched?.food?.doubt && { doubt: matched.food.doubt }),
      });
    },
  );

  server.registerTool(
    'set_unit_weight',
    {
      description:
        'Say what one unit of an ingredient weighs, such as 1 cup of flour = 125 g, 1 piece of English cucumber = 400 g, or 1 can of coconut milk = 400 g. A volume unit sets the ingredient\'s weight for every volume. The household\'s weight is kept, used from then on, and saved as a decision.',
      inputSchema: z.object({
        ingredient: z.string().min(1).describe('The ingredient as list_ingredients shows it'),
        unit: z.enum(UNITS),
        grams: z.number().positive().describe('Grams in one unit'),
      }),
    },
    async ({ ingredient, unit, grams }) => {
      const household = await member();
      const { entries, known } = await loadIngredients(household.id);
      if (!known.has(ingredient)) throw new Error(`"${ingredient}" isn't a known ingredient. Check list_ingredients for the exact name.`);
      const previous = entries.find((entry) => entry.name === ingredient);
      const saved = withUnitWeight(entries, ingredient, unit, grams);
      await ingredients.save(household.id, [saved]);
      await decisions.record(household.id, {
        kind: 'unit-weight',
        input: { ingredient, unit },
        suggestion: previous ? describeWeights(previous) : null,
        answer: grams,
        by: actingUid,
      });
      return jsonResult({ ingredient, weights: describeWeights(saved) });
    },
  );

  server.registerTool(
    'read_notes',
    {
      description:
        "Read the household's notes: long-term rules and facts that don't fit a tool, such as \"no cilantro\" or \"we cook with broth, not wine\". Without a path, returns every note.",
      inputSchema: z.object({ path: NotePath.optional().describe('One note, such as "ingredients.md"') }),
    },
    async ({ path }) => {
      const household = await member();
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
      const household = await member();
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
      const household = await member();
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

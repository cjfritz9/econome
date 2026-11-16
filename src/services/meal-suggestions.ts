import { weeksEndingWith, type CalendarWeek } from '../core/calendar.ts';
import { recipeNutrition } from '../core/nutrition.ts';
import type { Household } from '../data/household.ts';
import type { IngredientRegistry } from '../data/ingredients.ts';
import type { Notes } from '../data/notes.ts';
import type { MealPick } from '../data/suggestions.ts';
import { indexByLine, type ParsedLines } from '../data/parsed-lines.ts';
import { readLibrary, type Recipe, type Recipes } from '../data/recipes.ts';
import { withDefaults } from '../data/settings.ts';
import {
  emptyWeek,
  lastPlannedDates,
  loadWeeks,
  MEAL_SLOTS,
  planMeals,
  RECENT_WEEKS,
  weekCoverage,
  type MealRequest,
  type MealSlot,
  type MealTargets,
  type Weeks,
} from '../data/weeks.ts';
import type { Claude } from '../llm/claude.ts';
import { pickMeals, type MealContext } from '../llm/pick-meals.ts';
import { logger } from '../logger.ts';

const MOST_MEAL_PICKS = 8;
const BREAKFAST_TAG = 'breakfast';

export interface MealSuggestionDeps {
  recipes: Recipes;
  weeks: Weeks;
  parsedLines: ParsedLines;
  ingredients: IngredientRegistry;
  notes: Notes;
  claude: Claude;
  now?: () => Date;
}

export type MealSuggestion = MealPick;

export interface MealSuggestions {
  week: CalendarWeek;
  people: number;
  coverage: ReturnType<typeof weekCoverage>;
  targets: MealTargets;
  left: Record<MealSlot, number>;
  rankedBy: 'directive' | 'protein';
  madeAt: string | null;
  directive: string;
  warning?: string;
  suggestions: MealSuggestion[];
}

interface Candidate {
  recipe: Recipe;
  protein: number | null;
  kcal: number | null;
  line: string;
}

const round = (value: number) => Math.round(value);

const candidateOf = (recipe: Recipe, facts: ReturnType<typeof recipeNutrition>, lastPlanned: string | undefined): Candidate => {
  const n = facts.perServing;
  const nutrition = n
    ? `${round(n.kcal)} kcal, ${round(n.protein)} g, ${round(n.carbs)} g, ${round(Math.max(0, n.carbs - n.fiber))} g, ${round(n.sugar)} g, ${round(n.fat)} g, ${round(n.fiber)} g (${facts.estimate})`
    : 'no estimate yet';
  return {
    recipe,
    protein: n ? round(n.protein) : null,
    kcal: n ? round(n.kcal) : null,
    line: [recipe.title, `${recipe.servings}`, recipe.tags.join(', ') || 'no tags', nutrition, lastPlanned ?? 'never'].join(' | '),
  };
};

const slotFor = (recipe: Recipe, left: Record<MealSlot, number>): MealSlot =>
  recipe.tags.some((tag) => tag.toLowerCase() === BREAKFAST_TAG) && left.breakfast > 0 ? 'breakfast' : 'dinner';

export const mealSuggestionService = ({ recipes, weeks, parsedLines, ingredients, notes, claude, now = () => new Date() }: MealSuggestionDeps) => {

  const suggest = async (household: Household, week: CalendarWeek, draft?: MealRequest[], { renew = false } = {}): Promise<MealSuggestions> => {
    const settings = withDefaults(household.settings);
    const [docs, planned, lines, entries, allNotes, stored] = await Promise.all([
      recipes.listRecipeDocs(household.id),
      loadWeeks(weeks, household.id, weeksEndingWith(week, RECENT_WEEKS)),
      parsedLines.list(household.id),
      ingredients.list(household.id),
      notes.list(household.id),
      weeks.findSuggestions(household.id, week.id),
    ]);
    const library = readLibrary(docs);
    const thisWeek = planned.find(({ week: { id } }) => id === week.id) ?? { week, ...emptyWeek() };
    const meals = draft ? planMeals(library.recipes, draft) : thisWeek.meals;
    const people = household.members.length;
    const targets = { ...settings.mealTargets, ...thisWeek.targets };
    const leftOf = (coverage: ReturnType<typeof weekCoverage>) =>
      Object.fromEntries(MEAL_SLOTS.map((slot) => [slot, coverage[slot].leftToPlan ?? 0])) as Record<MealSlot, number>;
    const coverage = weekCoverage({ meals, hungryroot: thisWeek.hungryroot }, people, targets);
    const left = leftOf(coverage);
    const afterBox = leftOf(weekCoverage({ meals: [], hungryroot: thisWeek.hungryroot }, people, targets));
    const directive = allNotes.find(({ path }) => path === settings.planningDirective);
    const base = { week, people, coverage, targets, left, directive: settings.planningDirective };

    const inWeek = new Set(meals.map(({ recipeId }) => recipeId));
    const before = lastPlannedDates(planned.filter(({ week: { id } }) => id !== week.id));
    const byKey = indexByLine(lines);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const candidates = library.recipes.map((recipe) => candidateOf(recipe, recipeNutrition(recipe, byKey, byName), before.get(recipe.id)));
    const shown = (suggestions: MealSuggestion[]) =>
      Object.values(left).every((servings) => servings === 0)
        ? []
        : suggestions.filter(({ recipeId }) => !inWeek.has(recipeId)).slice(0, MOST_MEAL_PICKS);

    if (stored.meals && !renew) return { ...base, rankedBy: 'directive', madeAt: stored.meals.madeAt, suggestions: shown(stored.meals.picks) };
    const shownBefore = renew && stored.meals ? new Set([...stored.meals.seen, ...stored.meals.picks.map(({ recipeId }) => recipeId)]) : new Set<string>();
    const unseen = candidates.filter(({ recipe }) => !shownBefore.has(recipe.id) && !inWeek.has(recipe.id));
    const startOver = unseen.length === 0;
    const offered = startOver ? candidates : candidates.filter(({ recipe }) => !shownBefore.has(recipe.id));
    const seenIds = startOver ? [] : [...shownBefore];

    const byProtein = (warning: string): MealSuggestions => ({
      ...base,
      rankedBy: 'protein',
      madeAt: null,
      warning,
      suggestions: shown(
        candidates
          .filter(({ protein, kcal }) => protein !== null && kcal)
          .sort((a, b) => (b.protein ?? 0) / (b.kcal ?? 1) - (a.protein ?? 0) / (a.kcal ?? 1))
          .map(({ recipe }) => ({ recipeId: recipe.id, slot: slotFor(recipe, afterBox), servings: recipe.servings, why: [] })),
      ),
    });
    if (!directive) return byProtein(`There's no planning directive at ${settings.planningDirective}, so these are ranked by protein per calorie.`);
    if (Object.values(afterBox).every((servings) => servings === 0)) return { ...base, rankedBy: 'directive', madeAt: null, suggestions: [] };

    const context: MealContext = { people, left: afterBox, box: thisWeek.hungryroot.map(({ title }) => title) };
    const recipeLines = offered.map(({ recipe, line }) => ({ id: recipe.id, line }));

    try {
      const byId = new Map(offered.map((candidate) => [candidate.recipe.id, candidate]));
      const picks = await pickMeals(claude, household, directive.content, context, recipeLines);
      const seen = new Set<string>();
      const ranked = picks.flatMap(({ id, slot, why }) => {
        const candidate = byId.get(id);
        if (!candidate || seen.has(id)) return [];
        seen.add(id);
        return [{ recipeId: id, slot, servings: candidate.recipe.servings, why: why.slice(0, 2) }];
      });
      const madeAt = now().toISOString();
      await weeks.saveSuggestions(household.id, week.id, 'meals', { madeAt, picks: ranked, seen: seenIds });
      return { ...base, rankedBy: 'directive', madeAt, suggestions: shown(ranked) };
    } catch (error) {
      logger.warn({ err: error, week: week.id }, "Claude couldn't rank the meal suggestions; ranking by protein instead");
      return byProtein("Économe couldn't rank these by your planning directive just now, so they're ranked by protein per calorie.");
    }
  };

  return { suggest };
};

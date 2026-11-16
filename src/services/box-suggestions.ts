import { weeksEndingWith, type CalendarWeek } from '../core/calendar.ts';
import { boxCandidates, dishOf, distinctDishes, rankCandidates, type BoxCandidate } from '../core/hungryroot-box.ts';
import { fromCatalog } from '../core/hungryroot-translate.ts';
import type { Household } from '../data/household.ts';
import type { HungryrootCatalogStore, StoredCatalogRecipe } from '../data/hungryroot-catalog.ts';
import type { HungryrootUnavailable } from '../data/hungryroot-unavailable.ts';
import type { Notes } from '../data/notes.ts';
import type { BoxPick } from '../data/suggestions.ts';
import { withDefaults } from '../data/settings.ts';
import { loadWeeks, type Weeks } from '../data/weeks.ts';
import type { Claude } from '../llm/claude.ts';
import { MOST_PICKS, pickBox } from '../llm/pick-box.ts';
import { logger } from '../logger.ts';
import type { HungryrootProduct } from '../sources/hungryroot.ts';

const SHORTLIST = 40;
const MIN_PROTEIN = 25;
const RECENT_BOX_WEEKS = 4;
const SERVINGS_PER_RECIPE = 4;
const DEFAULT_BOX_SERVINGS = 12;

export interface BoxSuggestionDeps {
  catalog: Pick<HungryrootCatalogStore, 'recentRuns' | 'allRecipes' | 'allProducts'>;
  unavailable: Pick<HungryrootUnavailable, 'list'>;
  weeks: Weeks;
  notes: Notes;
  claude: Claude;
  now?: () => Date;
}

export type Suggestion = BoxPick;

export interface BoxSuggestions {
  week: CalendarWeek;
  boxServings: number;
  chosenServings: number;
  wanted: number;
  rankedBy: 'directive' | 'protein';
  madeAt: string | null;
  directive: string;
  warning?: string;
  suggestions: Suggestion[];
}

const round = (value: number | null | undefined) => Math.round(value ?? 0);

const candidateLine = ({ recipe, times, credits, starch, carbsWithoutStarch }: BoxCandidate) => {
  const n = recipe.nutrition;
  const swap = starch.length > 0 ? `${starch.map(({ product }) => product).join(' + ')}, ${carbsWithoutStarch} g without` : 'none';
  return [
    recipe.name,
    times === 2 ? `${recipe.servings} added twice` : `${recipe.servings}`,
    `${credits}`,
    `${round(n?.kcal)} kcal, ${round(n?.protein)} g, ${round(n?.carbs)} g, ${round(Math.max(0, (n?.carbs ?? 0) - (n?.fiber ?? 0)))} g, ${round(n?.sugar)} g, ${round(n?.fat)} g, ${round(n?.fiber)} g`,
    swap,
    `${recipe.minutes ?? '?'} min`,
  ].join(' | ');
};

const suggestionOf = (candidate: BoxCandidate, why: string[]): Suggestion => ({
  id: candidate.recipe.slug,
  times: candidate.times,
  servings: candidate.recipe.servings * candidate.times,
  credits: candidate.credits,
  why,
  ...(candidate.starch.length > 0 &&
    candidate.carbsWithoutStarch !== null && {
      swap: { remove: candidate.starch.map(({ product }) => product), carbsAfter: candidate.carbsWithoutStarch },
    }),
});

export const boxSuggestionService = ({ catalog, unavailable, weeks, notes, claude, now = () => new Date() }: BoxSuggestionDeps) => {
  let copy: { runAt: number; recipes: StoredCatalogRecipe[]; products: HungryrootProduct[] } | null = null;

  const currentCopy = async () => {
    const [latest] = await catalog.recentRuns(1);
    const runAt = latest?.at.getTime() ?? 0;
    if (!copy || copy.runAt !== runAt) {
      const [recipes, products] = await Promise.all([catalog.allRecipes(), catalog.allProducts()]);
      copy = { runAt, recipes, products };
    }
    return copy;
  };

  const suggest = async (household: Household, week: CalendarWeek, { renew = false } = {}): Promise<BoxSuggestions> => {
    const settings = withDefaults(household.settings);
    const [planned, allNotes, stored, marked] = await Promise.all([
      loadWeeks(weeks, household.id, weeksEndingWith(week, RECENT_BOX_WEEKS + 1)),
      notes.list(household.id),
      weeks.findSuggestions(household.id, week.id),
      unavailable.list(household.id),
    ]);
    const notAvailable = new Set(marked.map(({ id }) => id));
    const box = planned.find(({ week: { id } }) => id === week.id)?.hungryroot ?? [];
    const boxServings = settings.hungryroot?.boxServings ?? DEFAULT_BOX_SERVINGS;
    const chosenServings = box.reduce((sum, { servings }) => sum + servings, 0);
    const wanted = Math.max(0, Math.round((boxServings - chosenServings) / SERVINGS_PER_RECIPE));
    const directive = allNotes.find(({ path }) => path === settings.planningDirective);
    const base = { week, boxServings, chosenServings, wanted, directive: settings.planningDirective };
    const inBox = new Set(box.flatMap(({ slug }) => slug ?? []));
    const shown = (picks: Suggestion[]) => picks.filter(({ id }) => !inBox.has(id) && !notAvailable.has(id)).slice(0, MOST_PICKS);

    if (stored.box && !renew) return { ...base, rankedBy: 'directive', madeAt: stored.box.madeAt, suggestions: shown(stored.box.picks) };
    const shownBefore = renew && stored.box ? new Set([...stored.box.seen, ...stored.box.picks.map(({ id }) => id)]) : new Set<string>();

    const current = await currentCopy();
    const offered = current.recipes
      .filter(({ id, hungryroot }) => hungryroot.featured && !hungryroot.gone && !notAvailable.has(id))
      .map(fromCatalog);
    const ranked = rankCandidates(
      boxCandidates(
        offered.filter(({ servings }) => servings === 4),
        offered.filter(({ servings }) => servings === 2),
        current.products,
      ),
      { minProtein: MIN_PROTEIN, exclude: planned.flatMap(({ hungryroot }) => hungryroot.map(({ title }) => title)) },
    );
    const productsById = new Map(current.products.map((product) => [product.id, product]));
    const dish = ({ recipe }: BoxCandidate) => dishOf(recipe, productsById);
    const shownDishes = offered.filter(({ slug }) => shownBefore.has(slug)).map((recipe) => dishOf(recipe, productsById));
    const unseen = distinctDishes(
      ranked.filter(({ recipe }) => !shownBefore.has(recipe.slug)),
      dish,
      shownDishes,
    );
    const startOver = unseen.length === 0;
    const shortlist = (startOver ? distinctDishes(ranked, dish) : unseen).slice(0, SHORTLIST);
    const seenIds = startOver ? [] : [...shownBefore];

    const byProtein = (warning: string): BoxSuggestions => ({
      ...base,
      rankedBy: 'protein',
      madeAt: null,
      warning,
      suggestions: shown(shortlist.map((candidate) => suggestionOf(candidate, []))),
    });
    if (!directive) return byProtein(`There's no planning directive at ${settings.planningDirective}, so these are ranked by protein per calorie.`);
    if (shortlist.length === 0) return { ...base, rankedBy: 'directive', madeAt: null, suggestions: [] };

    try {
      const byId = new Map(shortlist.map((candidate) => [candidate.recipe.slug, candidate]));
      const picks = await pickBox(
        claude,
        household,
        directive.content,
        wanted,
        shortlist.map((candidate) => ({ id: candidate.recipe.slug, line: candidateLine(candidate) })),
      );
      const seen = new Set<string>();
      const made = picks
        .flatMap(({ id, why }) => {
          const candidate = byId.get(id);
          if (!candidate || seen.has(id)) return [];
          seen.add(id);
          return [suggestionOf(candidate, why.slice(0, 2))];
        })
        .slice(0, MOST_PICKS);
      const madeAt = now().toISOString();
      await weeks.saveSuggestions(household.id, week.id, 'box', { madeAt, picks: made, seen: seenIds });
      return { ...base, rankedBy: 'directive', madeAt, suggestions: shown(made) };
    } catch (error) {
      logger.warn({ err: error, week: week.id }, "Claude couldn't rank the box suggestions; ranking by protein instead");
      return byProtein("Économe couldn't rank these by your planning directive just now, so they're ranked by protein per calorie.");
    }
  };

  return { suggest };
};

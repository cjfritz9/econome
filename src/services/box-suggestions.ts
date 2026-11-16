import { createHash } from 'node:crypto';
import { weeksEndingWith, type CalendarWeek } from '../core/calendar.ts';
import { boxCandidates, rankCandidates, sameName, type BoxCandidate } from '../core/hungryroot-box.ts';
import { fromCatalog } from '../core/hungryroot-translate.ts';
import type { Household } from '../data/household.ts';
import type { HungryrootCatalogStore, StoredCatalogRecipe } from '../data/hungryroot-catalog.ts';
import type { Notes } from '../data/notes.ts';
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
const PICKS_KEPT_MS = 6 * 60 * 60 * 1000;

export interface BoxSuggestionDeps {
  catalog: Pick<HungryrootCatalogStore, 'recentRuns' | 'allRecipes' | 'allProducts'>;
  weeks: Weeks;
  notes: Notes;
  claude: Claude;
  now?: () => Date;
}

export interface Suggestion {
  id: string;
  times: number;
  servings: number;
  credits: number;
  why: string[];
  swap?: { remove: string[]; carbsAfter: number };
}

export interface BoxSuggestions {
  week: CalendarWeek;
  boxServings: number;
  chosenServings: number;
  wanted: number;
  rankedBy: 'directive' | 'protein';
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
    `${round(n?.kcal)} kcal, ${round(n?.protein)} g, ${round(n?.carbs)} g, ${round(n?.fat)} g, ${round(n?.fiber)} g`,
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

export const boxSuggestionService = ({ catalog, weeks, notes, claude, now = () => new Date() }: BoxSuggestionDeps) => {
  let copy: { runAt: number; recipes: StoredCatalogRecipe[]; products: HungryrootProduct[] } | null = null;
  const kept = new Map<string, { at: number; result: BoxSuggestions }>();

  const currentCopy = async () => {
    const [latest] = await catalog.recentRuns(1);
    const runAt = latest?.at.getTime() ?? 0;
    if (!copy || copy.runAt !== runAt) {
      const [recipes, products] = await Promise.all([catalog.allRecipes(), catalog.allProducts()]);
      copy = { runAt, recipes, products };
    }
    return copy;
  };

  const suggest = async (household: Household, week: CalendarWeek): Promise<BoxSuggestions> => {
    const settings = withDefaults(household.settings);
    const [current, planned, allNotes] = await Promise.all([
      currentCopy(),
      loadWeeks(weeks, household.id, weeksEndingWith(week, RECENT_BOX_WEEKS + 1)),
      notes.list(household.id),
    ]);
    const box = planned.find(({ week: { id } }) => id === week.id)?.hungryroot ?? [];
    const leaveOut = planned.flatMap(({ hungryroot }) => hungryroot.map(({ title }) => title));
    const boxServings = settings.hungryroot?.boxServings ?? DEFAULT_BOX_SERVINGS;
    const chosenServings = box.reduce((sum, { servings }) => sum + servings, 0);
    const wanted = Math.max(0, Math.round((boxServings - chosenServings) / SERVINGS_PER_RECIPE));
    const directive = allNotes.find(({ path }) => path === settings.planningDirective);

    const offered = current.recipes
      .filter(({ hungryroot }) => hungryroot.featured && !hungryroot.gone)
      .map(fromCatalog);
    const ranked = rankCandidates(
      boxCandidates(
        offered.filter(({ servings }) => servings === 4),
        offered.filter(({ servings }) => servings === 2),
        current.products,
      ),
      { minProtein: MIN_PROTEIN, exclude: leaveOut },
    );
    const shortlist = ranked.slice(0, SHORTLIST);
    const base = { week, boxServings, chosenServings, wanted, directive: settings.planningDirective };

    const key = createHash('sha256')
      .update(JSON.stringify([household.id, week.id, current.runAt, leaveOut.map(sameName).sort(), wanted, directive?.updatedAt ?? null]))
      .digest('hex');
    const remembered = kept.get(key);
    if (remembered && now().getTime() - remembered.at < PICKS_KEPT_MS) return remembered.result;

    const byProtein = (warning: string): BoxSuggestions => ({
      ...base,
      rankedBy: 'protein',
      warning,
      suggestions: shortlist.slice(0, MOST_PICKS).map((candidate) => suggestionOf(candidate, [])),
    });
    if (!directive) return byProtein(`There's no planning directive at ${settings.planningDirective}, so these are ranked by protein per calorie.`);
    if (shortlist.length === 0) return { ...base, rankedBy: 'directive', suggestions: [] };

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
      const suggestions = picks.flatMap(({ id, why }) => {
        const candidate = byId.get(id);
        if (!candidate || seen.has(id)) return [];
        seen.add(id);
        return [suggestionOf(candidate, why.slice(0, 2))];
      });
      const result: BoxSuggestions = { ...base, rankedBy: 'directive', suggestions: suggestions.slice(0, MOST_PICKS) };
      kept.set(key, { at: now().getTime(), result });
      return result;
    } catch (error) {
      logger.warn({ err: error, week: week.id }, "Claude couldn't rank the box suggestions; ranking by protein instead");
      return byProtein("Économe couldn't rank these by your planning directive just now, so they're ranked by protein per calorie.");
    }
  };

  return { suggest };
};

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as z from 'zod';
import { chooseWeek, weeksEndingWith } from '../core/calendar.ts';
import { uniqueLines } from '../core/ingredient-lines.ts';
import { recipeNutrition } from '../core/nutrition.ts';
import type { Job } from '../data/jobs.ts';
import { indexByLine } from '../data/parsed-lines.ts';
import { readLibrary } from '../data/recipes.ts';
import { emptyWeek, lastPlannedDates, loadWeeks, MealSlot, planMeals, RECENT_WEEKS } from '../data/weeks.ts';
import { logger } from '../logger.ts';
import { RefusedError, UnavailableError, UpstreamError } from '../services/errors.ts';
import { lookupService, type LookupDeps } from '../services/lookups.ts';
import { weekList, type ListDeps } from '../services/week-list.ts';
import { dateParam, jsonBody, type Env } from './context.ts';
import { jobView, weekView } from './views.ts';

const MAX_MEALS = 60;

const MealsBody = z.object({
  meals: z.array(z.object({ recipeId: z.string().min(1), slot: MealSlot.optional() })).max(MAX_MEALS),
});

export type PlanDeps = LookupDeps & ListDeps;

export const planRoutes = (deps: PlanDeps) => {
  const routes = new Hono<Env>();
  const lookups = lookupService(deps);
  const now = deps.now ?? (() => new Date());

  routes.get('/recipes/facts', async (c) => {
    const household = c.var.household;
    const recent = weeksEndingWith(chooseWeek(household.settings.timezone, undefined, now()), RECENT_WEEKS);
    const [docs, planned, lines, entries] = await Promise.all([
      deps.recipes.listRecipeDocs(household.id),
      loadWeeks(deps.weeks, household.id, recent),
      deps.parsedLines.list(household.id),
      deps.ingredients.list(household.id),
    ]);
    const library = readLibrary(docs);
    const lastPlanned = lastPlannedDates(planned);
    const byKey = indexByLine(lines);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const facts = library.recipes.map((recipe) => {
      const { perServing, estimate, gaps } = recipeNutrition(recipe, byKey, byName);
      return [
        recipe.id,
        {
          perServing,
          estimate,
          ...(estimate === 'partial' && { leftOut: gaps }),
          unreadLines: uniqueLines(recipe).filter(({ key }) => !byKey.has(key)).length,
          lastPlanned: lastPlanned.get(recipe.id) ?? null,
          notAgain: false,
        },
      ];
    });
    return c.json({ recipes: Object.fromEntries(facts), ...(library.skipped.length > 0 && { skipped: library.skipped }) });
  });

  routes.put('/weeks/:date/meals', async (c) => {
    const { meals: requests } = await jsonBody(c, MealsBody);
    const household = c.var.household;
    const date = dateParam(c);
    const week = chooseWeek(household.settings.timezone, date);
    const library = readLibrary(await deps.recipes.listRecipeDocs(household.id));
    const known = new Set(library.recipes.map(({ id }) => id));
    const unknown = [...new Set(requests.map(({ recipeId }) => recipeId).filter((id) => !known.has(id)))];
    if (unknown.length > 0) {
      throw new HTTPException(400, { message: `These aren't recipes that can be planned: ${unknown.join(', ')}. Archived recipes and non-meals can't be planned.` });
    }
    await deps.weeks.savePlan(household.id, week.id, { meals: planMeals(library.recipes, requests) }, c.var.uid);

    const warnings: { message: string }[] = [];
    let lookup: Job | null = null;
    if (requests.length > 0) {
      try {
        await weekList(deps, household, date, { parse: true });
        lookup = await lookups.lookUpNew(household, date, c.var.uid);
      } catch (error: unknown) {
        if (error instanceof RefusedError || error instanceof UnavailableError || error instanceof UpstreamError) warnings.push({ message: error.message });
        else {
          logger.error({ err: error, week: week.id }, "Saving the week couldn't build its list");
          warnings.push({ message: "The week is saved, but its list couldn't be built just now. Open the list to try again." });
        }
      }
    }

    const [saved = { week, ...emptyWeek() }] = await loadWeeks(deps.weeks, household.id, [week]);
    return c.json({ ...weekView(saved, household), lookup: lookup && jobView(lookup, now()), warnings });
  });

  return routes;
};

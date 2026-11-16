import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as z from 'zod';
import { chooseWeek } from '../core/calendar.ts';
import { recipeRecord } from '../core/hungryroot-box.ts';
import { fromCatalog } from '../core/hungryroot-translate.ts';
import type { HungryrootCatalogStore } from '../data/hungryroot-catalog.ts';
import type { Notes } from '../data/notes.ts';
import type { Claude } from '../llm/claude.ts';
import { boxSuggestionService } from '../services/box-suggestions.ts';
import type { HungryrootRecipes } from '../data/hungryroot-recipes.ts';
import type { HungryrootUnavailable } from '../data/hungryroot-unavailable.ts';
import { emptyWeek, loadWeeks, type HungryrootMeal, type Weeks } from '../data/weeks.ts';
import { dateParam, jsonBody, type Env } from './context.ts';
import { weekRef, weekView } from './views.ts';

const MAX_RECIPES = 12;
const Names = z.array(z.string().trim().min(1)).max(20).optional();

const BoxBody = z.object({
  recipes: z
    .array(z.object({ id: z.string().min(1), times: z.number().int().min(1).max(4).optional(), removed: Names, added: Names }))
    .max(MAX_RECIPES),
});

const Limit = z.coerce.number().int().min(1).max(24).default(12);

export interface HungryrootDeps {
  catalog: Pick<HungryrootCatalogStore, 'recentRuns' | 'findRecipes' | 'allRecipes' | 'allProducts'>;
  hungryrootRecipes: HungryrootRecipes;
  unavailable: HungryrootUnavailable;
  weeks: Weeks;
  notes: Notes;
  claude: Claude;
  now?: () => Date;
}

const recipeId = (c: Context<Env>) => {
  const id = c.req.param('id') ?? '';
  if (!/^[^/]{1,300}$/.test(id)) throw new HTTPException(400, { message: "Give the recipe's catalogue id." });
  return id;
};

export const hungryrootRoutes = ({ catalog, hungryrootRecipes, unavailable, weeks, notes, claude, now = () => new Date() }: HungryrootDeps) => {
  const routes = new Hono<Env>();
  const suggestions = boxSuggestionService({ catalog, unavailable, weeks, notes, claude, now });

  const savedWeek = async (householdId: string, week: ReturnType<typeof chooseWeek>) => {
    const [saved = { week, ...emptyWeek() }] = await loadWeeks(weeks, householdId, [week]);
    return saved;
  };

  routes.put('/weeks/:date/hungryroot', async (c) => {
    const { recipes: chosen } = await jsonBody(c, BoxBody);
    const household = c.var.household;
    const week = chooseWeek(household.settings.timezone, dateParam(c));

    const repeated = chosen.map(({ id }) => id).filter((id, index, ids) => ids.indexOf(id) !== index);
    if (repeated.length > 0) {
      throw new HTTPException(400, { message: `List each recipe once, with times for how often it was added: ${[...new Set(repeated)].join(', ')}.` });
    }
    const found = new Map((await catalog.findRecipes([...new Set(chosen.map(({ id }) => id))])).map((recipe) => [recipe.id, recipe]));
    const unknown = chosen.filter(({ id }) => !found.has(id)).map(({ id }) => id);
    if (unknown.length > 0) throw new HTTPException(400, { message: `These aren't in the Hungryroot catalogue: ${unknown.join(', ')}.` });
    const gone = chosen.filter(({ id }) => found.get(id)?.hungryroot.gone).map(({ id }) => found.get(id)?.title ?? id);
    if (gone.length > 0) throw new HTTPException(400, { message: `Hungryroot no longer offers: ${gone.join(', ')}.` });

    const picks = chosen.flatMap((choice) => {
      const stored = found.get(choice.id);
      return stored ? [{ choice, recipe: fromCatalog(stored) }] : [];
    });
    const existing = new Map((await hungryrootRecipes.find(household.id, picks.map(({ recipe }) => String(recipe.id)))).map((record) => [record.id, record]));
    await hungryrootRecipes.save(
      household.id,
      picks.map(({ choice: { removed = [], added = [] }, recipe }) => recipeRecord(week.id, recipe, { removed, added }, existing.get(String(recipe.id)))),
    );
    const box = picks.map(
      ({ choice, recipe }): HungryrootMeal => ({
        title: recipe.name,
        servings: recipe.servings * (choice.times ?? 1),
        times: choice.times ?? 1,
        hungryrootId: recipe.id,
        slug: recipe.slug,
        ...(choice.removed?.length && { removed: choice.removed }),
        ...(choice.added?.length && { added: choice.added }),
      }),
    );
    await weeks.saveHungryroot(household.id, week.id, box, c.var.uid);
    const marked = new Set((await unavailable.list(household.id)).map(({ id }) => id));
    await unavailable.clear(household.id, box.flatMap(({ slug }) => (slug && marked.has(slug) ? [slug] : [])));
    return c.json(weekView(await savedWeek(household.id, week), household, now()));
  });

  const boxSuggestions = async (c: Context<Env>, renew: boolean) => {
    const household = c.var.household;
    const { week, ...result } = await suggestions.suggest(household, chooseWeek(household.settings.timezone, dateParam(c)), { renew });
    return c.json({ week: weekRef(week), ...result });
  };

  routes.get('/weeks/:date/hungryroot/suggestions', (c) => boxSuggestions(c, false));
  routes.post('/weeks/:date/hungryroot/suggestions/new', (c) => boxSuggestions(c, true));

  routes.post('/weeks/:date/hungryroot/lock', async (c) => {
    const household = c.var.household;
    const week = chooseWeek(household.settings.timezone, dateParam(c));
    const planned = await savedWeek(household.id, week);
    if (planned.hungryroot.length === 0) throw new HTTPException(409, { message: `${week.id} has no Hungryroot box yet; confirm one first.` });
    await weeks.lockBox(household.id, week.id, c.var.uid);
    return c.json(weekView({ ...planned, boxLocked: true }, household, now()));
  });

  routes.get('/hungryroot/unavailable', async (c) => {
    const marked = await unavailable.list(c.var.household.id);
    const listed = new Map((await catalog.findRecipes(marked.map(({ id }) => id))).map((recipe) => [recipe.id, !recipe.hungryroot.gone]));
    return c.json({
      recipes: marked
        .sort((a, b) => a.firstMarkedAt.localeCompare(b.firstMarkedAt))
        .map((record) => ({ ...record, stillListed: listed.get(record.id) ?? false })),
    });
  });

  routes.post('/hungryroot/unavailable/:id', async (c) => {
    const id = recipeId(c);
    const household = c.var.household;
    const [recipe] = await catalog.findRecipes([id]);
    if (!recipe) throw new HTTPException(400, { message: `${id} isn't in the Hungryroot catalogue.` });
    const body = (await jsonBody(c, z.object({ week: z.string().optional() }).nullable())) ?? {};
    const week = chooseWeek(household.settings.timezone, body.week);
    const at = now().toISOString();
    const record = await unavailable.mark(household.id, { id, title: recipe.title, hungryrootId: recipe.hungryroot.id, week: week.id, by: c.var.uid, at });
    return c.json({ recipe: record });
  });

  routes.delete('/hungryroot/unavailable/:id', async (c) => {
    await unavailable.clear(c.var.household.id, [recipeId(c)]);
    return c.json({ cleared: true });
  });

  routes.get('/hungryroot/runs', async (c) => {
    const limit = Limit.safeParse(c.req.query('limit'));
    if (!limit.success) throw new HTTPException(400, { message: 'Give limit as a whole number from 1 to 24.' });
    const runs = await catalog.recentRuns(limit.data);
    return c.json({
      runs: runs.map(({ at, seconds, error, counts }) => ({ at: at.toISOString(), seconds, ok: error === null, error, counts })),
    });
  });

  return routes;
};

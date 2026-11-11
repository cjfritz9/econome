import { Hono, type Context } from 'hono';
import * as z from 'zod';
import { chooseWeek } from '../core/calendar.ts';
import { matchItem } from '../core/instacart-match.ts';
import type { Decisions } from '../data/decisions.ts';
import { latestFinds, type Jobs } from '../data/jobs.ts';
import type { Household } from '../data/household.ts';
import { idsOf, setBuying, type Buying } from '../data/ingredients.ts';
import type { ProductMemory, VeganLine } from '../data/product-memory.ts';
import { emptyWeek, loadWeeks, OnHandSchema } from '../data/weeks.ts';
import { NotFoundError, RefusedError } from '../services/errors.ts';
import { loadRecentJobs } from '../services/lookups.ts';
import { retailerOf, storeService } from '../services/store.ts';
import { buyListFrom, weekList, type ListDeps } from '../services/week-list.ts';
import type { FoodData } from '../sources/fdc.ts';
import { dateParam, jsonBody, productParam, type Env } from './context.ts';
import { cartView, listView, productsView, shopState, weekView } from './views.ts';

export interface ShopDeps extends ListDeps {
  fdc: FoodData;
  productMemory: ProductMemory;
  veganLine: VeganLine;
  decisions: Decisions;
  jobs: Jobs;
  now?: () => Date;
}

const ProductId = z.string().regex(/^\d+$/, 'An Instacart product id');

const HaveBody = z
  .object({ ingredientId: z.string().min(1), state: z.enum(['none', 'some', 'all']), amount: OnHandSchema.shape.amount.optional(), unit: OnHandSchema.shape.unit.optional() })
  .refine(({ state, amount, unit }) => state !== 'some' || (amount !== undefined && unit !== undefined), { message: '"some" needs an amount and a unit (pack, or the item\'s own unit)' });

const BUYING: Record<'when-needed' | 'stocked' | 'never', Buying> = { 'when-needed': 'weekly', stocked: 'staple', never: 'never' };

const nameOf = (items: { ingredientId: string; ingredient: string }[], id: string) => {
  const found = items.find(({ ingredientId }) => ingredientId === id);
  if (!found) throw new NotFoundError(`"${id}" isn't on this week's list.`);
  return found.ingredient;
};

export const shopRoutes = (deps: ShopDeps) => {
  const routes = new Hono<Env>();

  const buyList = buyListFrom(deps);
  const store = (c: Context<Env>) => storeService({ ...deps, buyList }, c.var.uid);

  const listFor = async (household: Household, date: string, parse: boolean) => {
    const [found, memory] = await Promise.all([weekList(deps, household, date, { parse }), deps.productMemory.list(household.id)]);
    const entries = new Map(found.entries.map((entry) => [entry.name, entry]));
    return listView(found, (item) => matchItem(item, memory, entries.get(item.ingredient)));
  };

  const now = deps.now ?? (() => new Date());

  const productsFor = async (c: Context<Env>, date: string) => {
    const household = c.var.household;
    const week = chooseWeek(household.settings.timezone, date);
    const [{ buy, items, entries }, jobs] = await Promise.all([store(c).matchWeek(household, date), loadRecentJobs(deps.jobs, household.id, now())]);
    return productsView({ week, buy, items, entries }, retailerOf(household), latestFinds(jobs, week.id, now()), now());
  };

  const plannedWeek = async (household: Household, date: string) => {
    const week = chooseWeek(household.settings.timezone, date);
    const [planned = { week, ...emptyWeek() }] = await loadWeeks(deps.weeks, household.id, [week]);
    return planned;
  };

  routes.get('/weeks/:date', async (c) => c.json(weekView(await plannedWeek(c.var.household, dateParam(c)), c.var.household)));

  routes.get('/weeks/:date/list', async (c) => c.json(await listFor(c.var.household, dateParam(c), true)));

  routes.put('/weeks/:date/list/have', async (c) => {
    const { ingredientId, state, amount, unit } = await jsonBody(c, HaveBody);
    const household = c.var.household;
    const date = dateParam(c);
    const current = await listFor(household, date, false);
    const name = nameOf([...current.buy, ...current.have, ...current.staples], ingredientId);
    const answer = state === 'none' ? null : state === 'all' || amount === undefined || unit === undefined ? true : { amount, unit };
    await deps.weeks.saveHave(household.id, current.week.id, { [name]: answer });
    return c.json(await listFor(household, date, false));
  });

  routes.put('/weeks/:date/list/staples', async (c) => {
    const { ingredientId, out } = await jsonBody(c, z.object({ ingredientId: z.string().min(1), out: z.boolean() }));
    const household = c.var.household;
    const date = dateParam(c);
    const current = await listFor(household, date, false);
    const name = nameOf([...current.staples, ...current.buy.filter(({ runningLow }) => runningLow)], ingredientId);
    await deps.weeks.saveHave(household.id, current.week.id, { [name]: out ? false : null });
    return c.json(await listFor(household, date, false));
  });

  routes.put('/ingredients/:ingredientId/buying', async (c) => {
    const { buying } = await jsonBody(c, z.object({ buying: z.enum(['when-needed', 'stocked', 'never']) }));
    const household = c.var.household;
    const id = c.req.param('ingredientId');
    const [entries, lines] = await Promise.all([deps.ingredients.list(household.id), deps.parsedLines.list(household.id)]);
    const idOf = idsOf(entries);
    const name = [...entries.map(({ name: known }) => known), ...lines.map(({ parse }) => parse.ingredient)].find((known) => idOf(known) === id);
    if (!name) throw new NotFoundError(`"${id}" isn't a known ingredient.`);
    const saved = setBuying(entries, [name], BUYING[buying], null);
    await deps.ingredients.save(household.id, saved);
    await deps.decisions.record(household.id, {
      kind: 'ingredient-buying',
      input: [name],
      suggestion: { [name]: entries.find((entry) => entry.name === name)?.buying ?? null },
      answer: { buying: BUYING[buying], comesWith: null },
      by: c.var.uid,
    });
    return c.json({ ingredientId: id, ingredient: name, buying });
  });

  routes.get('/weeks/:date/products', async (c) => c.json(await productsFor(c, dateParam(c))));

  routes.put('/weeks/:date/products/vegan/:productId', async (c) => {
    const { name, vegan } = await jsonBody(c, z.object({ name: z.string().min(1), vegan: z.boolean() }));
    const productId = productParam(c);
    const date = dateParam(c);
    await store(c).reviewVegan(c.var.household, { productId, name, vegan });
    return c.json(await productsFor(c, date));
  });

  routes.put('/weeks/:date/products/:ingredientId', async (c) => {
    const { productId, name, size, covers } = await jsonBody(
      c,
      z.object({ productId: ProductId, name: z.string().min(1), size: z.string().min(1).optional(), covers: z.number().positive().optional() }),
    );
    const date = dateParam(c);
    const ingredient = nameOf((await productsFor(c, date)).items, c.req.param('ingredientId'));
    await store(c).chooseProduct(c.var.household, { ingredient, productId, name, ...(size && { size }), ...(covers && { covers }) });
    return c.json(await productsFor(c, date));
  });

  routes.post('/weeks/:date/products/:ingredientId/rejections', async (c) => {
    const { productId, reason } = await jsonBody(c, z.object({ productId: ProductId, reason: z.string().min(1).optional() }));
    const date = dateParam(c);
    const ingredient = nameOf((await productsFor(c, date)).items, c.req.param('ingredientId'));
    await store(c).rejectProduct(c.var.household, { ingredient, productId, ...(reason && { reason }) });
    return c.json(await productsFor(c, date));
  });

  routes.get('/products/:productId/vegan', async (c) => c.json(await store(c).veganDetail(c.var.household, productParam(c))));

  routes.post('/weeks/:date/instacart/approve', async (c) => {
    const { listHash, quantities = {} } = await jsonBody(
      c,
      z.object({ listHash: z.string().min(1), quantities: z.record(z.string(), z.number().int().positive()).optional() }),
    );
    const date = dateParam(c);
    const current = await productsFor(c, date);
    if (listHash !== current.listHash) throw new RefusedError('The list changed since you looked at it. Review it and approve again.');
    const byName = Object.fromEntries(Object.entries(quantities).map(([id, quantity]) => [nameOf(current.items, id), quantity]));
    const { lines, notInCart } = await store(c).approve(c.var.household, date, byName);
    const idOf = new Map(current.items.map(({ ingredient, ingredientId }) => [ingredient, ingredientId]));
    return c.json({
      week: current.week,
      lines: lines.map(({ ingredient, productId, name, quantity }) => ({ ingredientId: idOf.get(ingredient), ingredient, productId, product: name, quantity })),
      notInCart: notInCart.map((ingredient) => ({ ingredientId: idOf.get(ingredient), ingredient })),
    });
  });

  const cartFor = async (c: Context<Env>, date: string) => {
    const planned = await plannedWeek(c.var.household, date);
    const settled = ['approved', 'filled', 'differences'].includes(shopState(planned));
    return cartView(planned, settled ? (await productsFor(c, date)).listHash : null);
  };

  routes.get('/weeks/:date/instacart', async (c) => c.json(await cartFor(c, dateParam(c))));

  routes.post('/weeks/:date/instacart/checked-out', async (c) => {
    const date = dateParam(c);
    await store(c).markCheckedOut(c.var.household, date);
    return c.json(await cartFor(c, date));
  });

  return routes;
};

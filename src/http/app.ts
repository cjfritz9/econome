import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import * as z from 'zod';
import { chooseWeek } from '../core/calendar.ts';
import { checkoutLink, fillOutcome, fillRequest, fillTarget, newFillId } from '../core/instacart-fill.ts';
import { combinedLines, compareCart, shortOf } from '../core/instacart-match.ts';
import { AccessError, ECONOME_FEATURE, requireFeature, type Access } from '../data/access.ts';
import { describeHousehold, requireHousehold, type DailySpend, type Households } from '../data/household.ts';
import type { HungryrootCatalogStore } from '../data/hungryroot-catalog.ts';
import type { HungryrootRecipes } from '../data/hungryroot-recipes.ts';
import type { HungryrootUnavailable } from '../data/hungryroot-unavailable.ts';
import type { InstacartNotAdded } from '../data/instacart-not-added.ts';
import { checkoutsOf, emptyWeek, loadWeeks, type InstacartSection, type RunKind, type SentItem, type Weeks } from '../data/weeks.ts';
import { logger } from '../logger.ts';
import { NotFoundError, RefusedError, UnavailableError, UpstreamError } from '../services/errors.ts';
import { lookupService, type LookupDeps } from '../services/lookups.ts';
import { buyListFrom, NothingPlannedError } from '../services/week-list.ts';
import type { RoutineTrigger, Routines } from '../sources/routines.ts';
import { bearerToken, dateParam, jsonBody, type Env } from './context.ts';
import { jobRoutes } from './jobs.ts';
import { hungryrootRoutes } from './hungryroot.ts';
import { planRoutes } from './plan.ts';
import { shopRoutes, type ShopDeps } from './shop.ts';

export interface TokenVerifier {
  uidOf: (idToken: string) => Promise<string>;
}

export interface HttpDeps extends ShopDeps, Omit<LookupDeps, 'buyList'> {
  verifier: TokenVerifier;
  access: Access;
  households: Households;
  spend: DailySpend;
  weeks: Weeks;
  routines: Routines;
  fillRoutine: RoutineTrigger | null;
  researchRoutine: RoutineTrigger | null;
  routineSecret: string | null;
  allowedOrigins: string[];
  catalog: Pick<HungryrootCatalogStore, 'recentRuns' | 'findRecipes' | 'allRecipes' | 'allProducts'>;
  hungryrootRecipes: HungryrootRecipes;
  unavailable: HungryrootUnavailable;
  notAdded: InstacartNotAdded;
}

const SAID_LENGTH = 500;
const said = (text: string | null | undefined) => text?.trim().slice(0, SAID_LENGTH) || null;

const FillBody = z.object({ only: z.literal('missing').optional() }).nullable();

const FillResultSchema = z.object({
  fill_id: z.string(),
  carts: z
    .array(
      z.object({
        retailer: z.string(),
        checkout_url: z.string().nullish(),
        lines: z.array(z.object({ product_id: z.string().regex(/^\d+$/), name: z.string().nullish(), quantity: z.number().positive() })),
        removed: z
          .array(z.object({ product_id: z.string().regex(/^\d+$/), name: z.string().nullish(), quantity: z.number().positive() }))
          .nullish()
          .transform((lines) => lines ?? []),
        summary: z.string().nullish().transform(said),
        item_errors: z
          .array(z.object({ product_id: z.string(), message: z.string().transform(said) }))
          .nullish()
          .transform((errors) => errors ?? []),
      }),
    )
    .default([]),
  error: z.string().nullish(),
});

const ResearchResultSchema = z.object({
  job_id: z.string(),
  results: z
    .array(
      z.object({
        id: z.string().nullish(),
        store: z.string(),
        term: z.string(),
        for: z.string(),
        products: z.array(z.object({ product_id: z.string().regex(/^\d+$/), name: z.string().min(1), size: z.string().nullish() })),
      }),
    )
    .default([]),
  unrecognized_stores: z.array(z.string()).default([]),
  error: z.string().nullish(),
  done: z.boolean().default(false),
});

const digest = (text: string) => createHash('sha256').update(text).digest();
const sameSecret = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));

const sameStore = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' }) === 0;

export const createApp = ({ verifier, access, spend, fillRoutine, routineSecret, allowedOrigins, catalog, hungryrootRecipes, unavailable, ...shop }: HttpDeps) => {
  const { weeks, households, routines, notAdded } = shop;
  const now = shop.now ?? (() => new Date());
  const lookups = { ...shop, buyList: buyListFrom(shop) };
  const app = new Hono<Env>();

  const signedIn = createMiddleware<Env>(async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    if (!token) throw new HTTPException(401, { message: 'Sign in to Mise first.' });
    const uid = await verifier.uidOf(token).catch(() => null);
    if (!uid) throw new HTTPException(401, { message: 'Your sign-in has expired or is invalid. Sign in to Mise again.' });
    await requireFeature(access, uid, ECONOME_FEATURE);
    c.set('uid', uid);
    c.set('household', await requireHousehold(households, uid));
    await next();
  });

  const fromRoutine = createMiddleware<Env>(async (c, next) => {
    if (!routineSecret) throw new HTTPException(503, { message: "Routine results aren't set up on this server." });
    const given = bearerToken(c.req.header('authorization'));
    if (!given || !sameSecret(given, routineSecret)) throw new HTTPException(401, { message: 'Unknown sender.' });
    await next();
  });

  app.get('/health', (c) => c.json({ ok: true }));

  const isRefused = (origin: string | undefined, fetchSite: string | undefined) =>
    Boolean(origin && !allowedOrigins.includes(origin) && (fetchSite === 'cross-site' || fetchSite === 'same-site'));

  app.use(
    '/api/*',
    cors({
      origin: (origin, c) => {
        const readable = allowedOrigins.includes(origin) || c.req.method === 'OPTIONS' || isRefused(origin, c.req.header('sec-fetch-site'));
        return readable ? origin : null;
      },
      allowHeaders: ['Authorization', 'Content-Type'],
      allowMethods: ['GET', 'POST', 'PUT'],
    }),
  );
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (isRefused(origin, c.req.header('sec-fetch-site'))) throw new HTTPException(403, { message: `Économe doesn't accept requests from ${origin}.` });
    await next();
  });
  app.use('/api/*', signedIn);

  app.get('/api/household', async (c) => c.json(await describeHousehold(c.var.household, households, spend)));

  const approvedIn = (section: InstacartSection, weekId: string) => {
    if (!section.approved) throw new HTTPException(409, { message: `${weekId}'s Instacart cart isn't approved yet.` });
    return section.approved;
  };

  const startRun = async (c: Context<Env>, kind: RunKind, itemsOf: (section: InstacartSection, weekId: string) => SentItem[]) => {
    if (!fillRoutine) throw new HTTPException(503, { message: "The fill routine isn't set up on this server." });
    const household = c.var.household;
    const week = chooseWeek(household.settings.timezone, dateParam(c));
    const [planned = { week, ...emptyWeek() }] = await loadWeeks(weeks, household.id, [week]);
    const section = planned.instacart;
    const items = itemsOf(section, week.id);
    const retailer = section.retailer ?? household.settings.instacart?.retailer;
    if (!retailer) throw new HTTPException(409, { message: 'No Instacart store is set for this household.' });

    const fillId = newFillId(household.id, week);
    const run = await routines.fire(fillRoutine, fillRequest(fillId, retailer, items, { clear: kind === 'clear' })).catch((error: unknown) => {
      logger.error({ err: error, week: week.id, kind }, 'The fill routine would not start');
      throw new HTTPException(502, { message: "Claude's cart routine wouldn't start. Try again in a minute." });
    });
    const sent = { fillId, sessionId: run.sessionId, by: c.var.uid, error: null, kind, items };
    const saved = kind === 'fill' ? { ...section, sent, filled: null, checkedOut: null, checkouts: checkoutsOf(section) } : { ...section, sent };
    await weeks.saveInstacart(household.id, week.id, saved);
    return c.json({ week: week.id, kind, fillId, items: items.length, run: run.sessionUrl }, 202);
  };

  app.post('/api/weeks/:date/instacart/fill', async (c) => {
    const only = (await jsonBody(c, FillBody))?.only;
    return startRun(c, 'fill', (section, weekId) => {
      const approved = approvedIn(section, weekId);
      if (!only) return combinedLines(approved.lines);
      if (!section.filled) throw new RefusedError("Économe hasn't read this cart yet, so it can't tell what's missing. Check the cart first.");
      const short = shortOf(approved.lines, section.filled.lines);
      if (short.length === 0) throw new RefusedError("Nothing approved is missing from the cart as Économe last read it. Check the cart again if it's changed since.");
      return short;
    });
  });

  app.post('/api/weeks/:date/instacart/check', async (c) =>
    startRun(c, 'check', (section, weekId) => {
      approvedIn(section, weekId);
      return [];
    }),
  );

  app.post('/api/weeks/:date/instacart/clear', async (c) => startRun(c, 'clear', () => []));

  app.route('/api', shopRoutes(shop));
  app.route('/api', jobRoutes(lookups));
  app.route('/api', planRoutes(lookups));
  app.route(
    '/api',
    hungryrootRoutes({
      catalog,
      hungryrootRecipes,
      unavailable,
      weeks: shop.weeks,
      notes: shop.notes,
      claude: shop.claude,
      ...(shop.now && { now: shop.now }),
    }),
  );

  app.post('/routines/instacart-fill/result', fromRoutine, async (c) => {
    const result = await jsonBody(c, FillResultSchema);

    const target = fillTarget(result.fill_id);
    if (!target) throw new HTTPException(400, { message: "That isn't a fill ID Économe sends." });
    const [planned] = await loadWeeks(weeks, target.householdId, [target.week]);
    const section = planned?.instacart;
    const sent = section?.sent;
    if (!section || !sent || sent.fillId !== result.fill_id || (!section.approved && sent.kind !== 'clear')) {
      throw new HTTPException(404, { message: 'No fill with that ID is waiting.' });
    }
    if (section.filled?.fillId === result.fill_id || sent.error) throw new HTTPException(409, { message: "That fill's result is already recorded." });

    if (result.error) {
      await weeks.saveInstacart(target.householdId, target.week.id, { ...section, sent: { ...sent, error: result.error } });
      logger.warn({ week: target.week.id, error: result.error }, 'The fill routine reported an error');
      return c.json({ week: target.week.id, recorded: 'error' });
    }

    const retailer = section.retailer;
    const cart = result.carts.find((reported) => retailer && sameStore(reported.retailer, retailer)) ?? (result.carts.length === 1 ? result.carts[0] : undefined);
    if (!cart) throw new HTTPException(400, { message: `The result has no cart for ${retailer ?? "the week's store"}.` });
    const lines = cart.lines.map(({ product_id, name, quantity }) => ({ productId: product_id, quantity, name: name ?? null }));
    const at = now().toISOString();
    const removed = sent.kind === 'clear' ? cart.removed.map(({ product_id, name, quantity }) => ({ productId: product_id, quantity, name: name ?? null })) : null;
    const filled = { by: sent.by, lines, fillId: result.fill_id, checkoutUrl: checkoutLink(cart.checkout_url), kind: sent.kind, at, removed };
    const cleared = sent.kind === 'clear' && { checkedOut: null, checkouts: checkoutsOf(section) };
    await weeks.saveInstacart(target.householdId, target.week.id, { ...section, filled, ...cleared });

    if (sent.kind === 'fill' && section.approved) {
      const words = { summary: cart.summary, itemErrors: cart.item_errors.flatMap(({ product_id, message }) => (message ? [{ productId: product_id, message }] : [])) };
      const outcome = fillOutcome(sent.items ?? combinedLines(section.approved.lines), lines, section.approved.lines, words);
      await notAdded.record(target.householdId, { week: target.week.id, at, ...outcome }).catch((error: unknown) => {
        logger.error({ err: error, week: target.week.id, missed: outcome.missed.length }, "Couldn't record which products Instacart didn't add");
      });
    }
    return c.json({ week: target.week.id, ...(section.approved && compareCart(section.approved.lines, lines)) });
  });

  app.post('/routines/instacart-research/result', fromRoutine, async (c) => {
    const { job_id: jobId, results, unrecognized_stores: unrecognizedStores, error, done } = await jsonBody(c, ResearchResultSchema);
    const reported = results.map(({ id, store, term, for: forItem, products }) => ({
      id: id ?? null,
      store,
      term,
      for: forItem,
      products: products.map(({ product_id, name, size }) => ({ productId: product_id, name, size: size ?? null })),
    }));
    return c.json(await lookupService(lookups).record({ jobId, results: reported, unrecognizedStores, error: error ?? null, done }));
  });

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof AccessError) return c.json({ error: error.message }, 403);
    if (error instanceof NotFoundError || error instanceof NothingPlannedError) return c.json({ error: error.message }, 404);
    if (error instanceof RefusedError) return c.json({ error: error.message }, 409);
    if (error instanceof UpstreamError) return c.json({ error: error.message }, 502);
    if (error instanceof UnavailableError) return c.json({ error: error.message }, 503);
    logger.error({ err: error, path: c.req.path }, 'Request failed');
    return c.json({ error: 'Something went wrong in Économe.' }, 500);
  });

  return app;
};

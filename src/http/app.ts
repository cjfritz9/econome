import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import * as z from 'zod';
import { chooseWeek } from '../core/calendar.ts';
import { fillRequest, fillTarget, newFillId } from '../core/instacart-fill.ts';
import { compareCart } from '../core/instacart-match.ts';
import { AccessError, ECONOME_FEATURE, requireFeature, type Access } from '../data/access.ts';
import { describeHousehold, requireHousehold, type DailySpend, type Households } from '../data/household.ts';
import { loadWeeks, type Weeks } from '../data/weeks.ts';
import { logger } from '../logger.ts';
import { NotFoundError, RefusedError } from '../services/errors.ts';
import { NothingPlannedError } from '../services/week-list.ts';
import type { RoutineTrigger, Routines } from '../sources/routines.ts';
import { bearerToken, dateParam, type Env } from './context.ts';
import { shopRoutes, type ShopDeps } from './shop.ts';

export interface TokenVerifier {
  uidOf: (idToken: string) => Promise<string>;
}

export interface HttpDeps extends ShopDeps {
  verifier: TokenVerifier;
  access: Access;
  households: Households;
  spend: DailySpend;
  weeks: Weeks;
  routines: Routines;
  fillRoutine: RoutineTrigger | null;
  routineSecret: string | null;
  allowedOrigins: string[];
}

const FillResultSchema = z.object({
  fill_id: z.string(),
  carts: z
    .array(
      z.object({
        retailer: z.string(),
        lines: z.array(z.object({ product_id: z.string().regex(/^\d+$/), name: z.string().nullish(), quantity: z.number().positive() })),
      }),
    )
    .default([]),
  error: z.string().nullish(),
});

const digest = (text: string) => createHash('sha256').update(text).digest();
const sameSecret = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));

const sameStore = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' }) === 0;

export const createApp = ({ verifier, access, households, spend, routines, fillRoutine, routineSecret, allowedOrigins, ...shop }: HttpDeps) => {
  const { weeks } = shop;
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

  app.get('/health', (c) => c.json({ ok: true }));

  app.use('/api/*', cors({ origin: allowedOrigins, allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PUT'] }));
  app.use('/api/*', signedIn);

  app.get('/api/household', async (c) => c.json(await describeHousehold(c.var.household, households, spend)));

  app.post('/api/weeks/:date/instacart/fill', async (c) => {
    if (!fillRoutine) throw new HTTPException(503, { message: "The fill routine isn't set up on this server." });
    const household = c.var.household;
    const week = chooseWeek(household.settings.timezone, dateParam(c));
    const [planned] = await loadWeeks(weeks, household.id, [week]);
    const section = planned?.instacart;
    if (!section?.approved) throw new HTTPException(409, { message: `${week.id}'s Instacart cart isn't approved yet.` });
    const retailer = section.retailer ?? household.settings.instacart?.retailer;
    if (!retailer) throw new HTTPException(409, { message: 'No Instacart store is set for this household.' });

    const fillId = newFillId(household.id, week);
    const run = await routines.fire(fillRoutine, fillRequest(fillId, retailer, section.approved.lines)).catch((error: unknown) => {
      logger.error({ err: error, week: week.id }, 'The fill routine would not start');
      throw new HTTPException(502, { message: "Claude's fill routine wouldn't start. Try again in a minute." });
    });
    await weeks.saveInstacart(household.id, week.id, { ...section, sent: { fillId, sessionId: run.sessionId, by: c.var.uid, error: null }, filled: null });
    return c.json({ week: week.id, fillId, run: run.sessionUrl }, 202);
  });

  app.route('/api', shopRoutes(shop));

  app.post('/routines/instacart-fill/result', async (c) => {
    if (!routineSecret) throw new HTTPException(503, { message: "Routine results aren't set up on this server." });
    const given = bearerToken(c.req.header('authorization'));
    if (!given || !sameSecret(given, routineSecret)) throw new HTTPException(401, { message: 'Unknown sender.' });
    const parsed = FillResultSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) });
    const result = parsed.data;

    const target = fillTarget(result.fill_id);
    if (!target) throw new HTTPException(400, { message: "That isn't a fill ID Économe sends." });
    const [planned] = await loadWeeks(weeks, target.householdId, [target.week]);
    const section = planned?.instacart;
    const sent = section?.sent;
    if (!section?.approved || !sent || sent.fillId !== result.fill_id) throw new HTTPException(404, { message: 'No fill with that ID is waiting.' });
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
    await weeks.saveInstacart(target.householdId, target.week.id, { ...section, filled: { by: sent.by, lines, fillId: result.fill_id } });
    return c.json({ week: target.week.id, ...compareCart(section.approved.lines, lines) });
  });

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof AccessError) return c.json({ error: error.message }, 403);
    if (error instanceof NotFoundError || error instanceof NothingPlannedError) return c.json({ error: error.message }, 404);
    if (error instanceof RefusedError) return c.json({ error: error.message }, 409);
    logger.error({ err: error, path: c.req.path }, 'Request failed');
    return c.json({ error: 'Something went wrong in Économe.' }, 500);
  });

  return app;
};

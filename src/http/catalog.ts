import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as z from 'zod';
import type { HungryrootCatalogStore } from '../data/hungryroot-catalog.ts';
import type { Env } from './context.ts';

const Limit = z.coerce.number().int().min(1).max(24).default(12);

export const catalogRoutes = (catalog: Pick<HungryrootCatalogStore, 'recentRuns'>) => {
  const routes = new Hono<Env>();

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

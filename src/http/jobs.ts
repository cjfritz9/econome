import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as z from 'zod';
import { lookupService, type LookupDeps } from '../services/lookups.ts';
import { dateParam, jsonBody, type Env } from './context.ts';
import { jobView } from './views.ts';

export const jobRoutes = (deps: LookupDeps) => {
  const routes = new Hono<Env>();
  const lookups = lookupService(deps);
  const now = deps.now ?? (() => new Date());

  routes.get('/jobs', async (c) => {
    if (c.req.query('state') !== 'running') throw new HTTPException(400, { message: 'Ask for the running jobs, with ?state=running.' });
    const running = await lookups.running(c.var.household.id);
    return c.json({ jobs: running.map((job) => jobView(job, now())) });
  });

  routes.get('/jobs/:id', async (c) => c.json(jobView(await lookups.find(c.var.household.id, c.req.param('id')), now())));

  routes.post('/weeks/:date/products/lookups', async (c) => {
    const job = await lookups.startLookup(c.var.household, dateParam(c), c.var.uid);
    return c.json({ job: jobView(job, now()) }, 202);
  });

  routes.post('/weeks/:date/products/:ingredientId/searches', async (c) => {
    const { query } = await jsonBody(c, z.object({ query: z.string().trim().min(2).max(100) }));
    const job = await lookups.startSearch(c.var.household, dateParam(c), c.req.param('ingredientId'), query, c.var.uid);
    return c.json({ job: jobView(job, now()) }, 202);
  });

  return routes;
};

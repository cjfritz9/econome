import { chooseWeek, type CalendarWeek } from '../core/calendar.ts';
import { jobHousehold, newJobId, rankFound, researchRequest, type Candidate, type Found, type LookupItem } from '../core/lookups.ts';
import { householdOf, type Household, type Households } from '../data/household.ts';
import { idsOf } from '../data/ingredients.ts';
import { isExpired, jobState, readJob, recentSince, type Job, type JobData, type Jobs } from '../data/jobs.ts';
import { forIngredient } from '../data/product-memory.ts';
import { logger } from '../logger.ts';
import type { RoutineTrigger, Routines } from '../sources/routines.ts';
import { NotFoundError, RefusedError, UnavailableError, UpstreamError } from './errors.ts';
import { retailerOf, storeService, type StoreDeps } from './store.ts';
import { NothingPlannedError } from './week-list.ts';

const CANDIDATES_CHECKED = 8;

export interface LookupDeps extends StoreDeps {
  jobs: Jobs;
  households: Pick<Households, 'findHousehold'>;
  routines: Routines;
  researchRoutine: RoutineTrigger | null;
  now?: () => Date;
}

export interface ReportedSearch {
  id: string | null;
  store: string;
  term: string;
  for: string;
  products: Candidate[];
}

export interface ResearchResult {
  jobId: string;
  results: ReportedSearch[];
  unrecognizedStores: string[];
  error: string | null;
  done: boolean;
}

const sameStore = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' }) === 0;

const uniqueBy = <T>(items: T[], key: (item: T) => string) => [...new Map(items.map((item) => [key(item), item])).values()];

export const loadRecentJobs = async (jobs: Jobs, householdId: string, now: Date) => {
  const docs = await jobs.recent(householdId, recentSince(now));
  return docs.flatMap((doc) => {
    try {
      return [readJob(doc)];
    } catch (error: unknown) {
      logger.warn({ err: error, job: doc.id }, 'Skipped a job that could not be read');
      return [];
    }
  });
};

export const lookupService = (deps: LookupDeps) => {
  const { jobs, households, routines, researchRoutine } = deps;
  const now = deps.now ?? (() => new Date());

  const isRunning = (job: Job) => jobState(job, now()) === 'running';

  const start = async (household: Household, kind: Job['kind'], week: CalendarWeek, items: LookupItem[], by: string): Promise<Job> => {
    if (!researchRoutine) throw new UnavailableError("Lookups aren't set up on this server.");
    const retailer = retailerOf(household);
    const id = newJobId(household.id);
    const job: JobData = {
      kind,
      state: 'running',
      week: { id: week.id, start: week.start, end: week.end },
      retailer,
      items,
      found: {},
      startedAt: now().toISOString(),
      by,
      run: null,
      error: null,
    };
    await jobs.create(household.id, id, job);
    const run = await routines.fire(researchRoutine, researchRequest(id, retailer, items)).catch(async (error: unknown) => {
      logger.error({ err: error, job: id }, 'The research routine would not start');
      const message = "Claude's research routine wouldn't start. Try again in a minute.";
      await jobs.update(household.id, id, { state: 'failed', error: message });
      throw new UpstreamError(message);
    });
    await jobs.update(household.id, id, { run: run.sessionId });
    return { id, ...job, run: run.sessionId };
  };

  const listItems = async (household: Household, date: string, by: string) => {
    const { items, entries } = await storeService(deps, by).matchWeek(household, date);
    const idOf = idsOf(entries);
    return items.map((item) => ({ ...item, ingredientId: idOf(item.ingredient) }));
  };

  const startLookup = async (household: Household, date: string, by: string) => {
    const week = chooseWeek(household.settings.timezone, date);
    const items = await listItems(household, date, by);
    const wanted = items.filter(({ pick }) => !pick).map(({ ingredientId, ingredient, search }) => ({ ingredientId, ingredient, term: search ?? ingredient }));
    if (wanted.length === 0) throw new RefusedError('Every item on the list has a product already.');
    const running = (await loadRecentJobs(jobs, household.id, now())).find((job) => job.kind === 'lookup' && job.week.id === week.id && isRunning(job));
    return running ?? start(household, 'lookup', week, wanted, by);
  };

  const startSearch = async (household: Household, date: string, ingredientId: string, query: string, by: string) => {
    const week = chooseWeek(household.settings.timezone, date);
    const item = (await listItems(household, date, by)).find((listed) => listed.ingredientId === ingredientId);
    if (!item) throw new NotFoundError(`"${ingredientId}" isn't on this week's list.`);
    const term = query.trim();
    const running = (await loadRecentJobs(jobs, household.id, now())).find(
      (job) => job.kind === 'search' && job.week.id === week.id && isRunning(job) && job.items.some((asked) => asked.ingredientId === ingredientId && asked.term === term),
    );
    return running ?? start(household, 'search', week, [{ ingredientId, ingredient: item.ingredient, term }], by);
  };

  const running = async (householdId: string) => (await loadRecentJobs(jobs, householdId, now())).filter(isRunning);

  const find = async (householdId: string, jobId: string) => {
    const doc = await jobs.find(householdId, jobId);
    const job = doc && readJob(doc);
    if (!job || isExpired(job, now())) throw new NotFoundError('No job with that ID; jobs last a day.');
    return job;
  };

  const findings = async (household: Household, job: Job, reported: Map<string, Candidate[]>) => {
    const store = storeService(deps, job.by);
    const candidates = uniqueBy([...reported.values()].flat(), ({ productId }) => productId);
    const [checks, { buy }, memory, entries] = await Promise.all([
      store.checkProducts(household.id, candidates.map(({ productId, name }) => ({ productId, name }))),
      deps.buyList(household, job.week.start).catch((error: unknown) => {
        if (error instanceof NothingPlannedError) return { buy: [] };
        throw error;
      }),
      deps.productMemory.list(household.id),
      deps.ingredients.list(household.id),
    ]);
    const veganOf = new Map(checks.map(({ productId, verdict, reasons }) => [productId, { verdict, reasons }]));
    const listed = new Map(buy.map((item) => [item.ingredient, item]));
    const entryOf = new Map(entries.map((entry) => [entry.name, entry]));
    const ingredientOf = new Map(job.items.map(({ ingredientId, ingredient }) => [ingredientId, ingredient]));
    const found: Record<string, Found> = {};
    for (const [ingredientId, products] of reported) {
      const ingredient = ingredientOf.get(ingredientId) ?? ingredientId;
      const checked = products.map((product) => ({ ...product, vegan: veganOf.get(product.productId) ?? { verdict: 'needs-review' as const, reasons: ['not checked'] } }));
      found[ingredientId] = rankFound(checked, {
        item: listed.get(ingredient),
        entry: entryOf.get(ingredient),
        retailer: job.retailer,
        rejected: new Set(forIngredient(memory, ingredient, 'rejected').map(({ productId }) => productId)),
      });
    }
    return found;
  };

  const record = async ({ jobId, results, unrecognizedStores, error, done }: ResearchResult) => {
    const householdId = jobHousehold(jobId);
    const [doc, saved] = householdId ? await Promise.all([jobs.find(householdId, jobId), households.findHousehold(householdId)]) : [];
    if (!householdId || !doc || !saved) throw new NotFoundError('No job with that ID is waiting.');
    const job = readJob(doc);
    if (isExpired(job, now()) || !isRunning(job)) throw new RefusedError("That job isn't waiting for results any more.");

    const itemFor = (search: ReportedSearch) =>
      job.items.find(({ ingredientId }) => ingredientId === search.id) ??
      job.items.find(({ ingredient }) => ingredient === search.for) ??
      job.items.find(({ term }) => term === search.term);
    const reported = new Map<string, Candidate[]>();
    for (const search of results) {
      const item = itemFor(search);
      if (!sameStore(search.store, job.retailer) || !item) {
        logger.warn({ job: jobId, store: search.store, for: search.for }, 'The research routine reported a search Économe did not ask for');
        continue;
      }
      reported.set(item.ingredientId, uniqueBy([...(reported.get(item.ingredientId) ?? []), ...search.products], ({ productId }) => productId).slice(0, CANDIDATES_CHECKED));
    }

    const found = reported.size > 0 ? await findings(householdOf(saved), job, reported) : {};
    const storeUnknown = unrecognizedStores.some((store) => sameStore(store, job.retailer)) ? `Instacart doesn't recognize the store ${job.retailer}.` : null;
    const failure = error ?? storeUnknown;
    const answered = new Set([...Object.keys(job.found), ...Object.keys(found)]);
    const finished = done || failure !== null || job.items.every(({ ingredientId }) => answered.has(ingredientId));
    await jobs.update(householdId, jobId, {
      ...(Object.keys(found).length > 0 && { found }),
      ...(finished && { state: failure ? 'failed' : 'done', error: failure }),
    });
    return { job: jobId, recorded: Object.keys(found).length, state: finished ? (failure ? 'failed' : 'done') : 'running' };
  };

  return { startLookup, startSearch, running, find, record };
};

import * as z from 'zod';
import type { Found } from '../core/lookups.ts';

export const JOB_TIMEOUT_MS = 20 * 60 * 1000;
export const JOB_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const RECENT_JOBS = 50;

const SuggestionSchema = z.object({
  productId: z.string(),
  name: z.string(),
  size: z.string().nullable(),
  packages: z.number().nullable(),
  vegan: z.object({ verdict: z.enum(['vegan', 'non-vegan', 'needs-review']), reasons: z.array(z.string()) }),
  why: z.array(z.string()),
});

const FoundSchema = z.object({
  suggestions: z.array(SuggestionSchema),
  excluded: z.array(z.object({ productId: z.string(), name: z.string(), reason: z.string() })),
});

const JobSchema = z.object({
  kind: z.enum(['lookup', 'search']),
  state: z.enum(['running', 'done', 'failed']),
  week: z.object({ id: z.string(), start: z.string(), end: z.string() }),
  retailer: z.string(),
  items: z.array(z.object({ ingredientId: z.string(), ingredient: z.string(), term: z.string() })),
  found: z.record(z.string(), FoundSchema).default({}),
  startedAt: z.string(),
  by: z.string(),
  run: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});

export type JobData = z.infer<typeof JobSchema>;
export type Job = JobData & { id: string };
export type JobState = JobData['state'];

export interface JobDoc {
  id: string;
  data: unknown;
}

export interface JobUpdate {
  state?: JobState;
  error?: string | null;
  run?: string;
  found?: Record<string, Found>;
}

export interface Jobs {
  recent: (householdId: string, since: string) => Promise<JobDoc[]>;
  find: (householdId: string, jobId: string) => Promise<JobDoc | undefined>;
  create: (householdId: string, jobId: string, job: JobData) => Promise<void>;
  update: (householdId: string, jobId: string, update: JobUpdate) => Promise<void>;
}

export const readJob = ({ id, data }: JobDoc): Job => ({ id, ...JobSchema.parse(data) });

const age = (job: Pick<Job, 'startedAt'>, now: Date) => now.getTime() - Date.parse(job.startedAt);

export const isExpired = (job: Pick<Job, 'startedAt'>, now: Date) => age(job, now) > JOB_LIFETIME_MS;

export const jobState = (job: Pick<Job, 'state' | 'startedAt'>, now: Date): JobState =>
  job.state === 'running' && age(job, now) > JOB_TIMEOUT_MS ? 'failed' : job.state;

export const jobError = (job: Pick<Job, 'state' | 'startedAt' | 'error'>, now: Date) =>
  job.state === 'running' && jobState(job, now) === 'failed' ? "Claude's research routine didn't report back within 20 minutes." : job.error;

export const recentSince = (now: Date) => new Date(now.getTime() - JOB_LIFETIME_MS).toISOString();

export const latestFinds = (jobs: Job[], weekId: string, now: Date) => {
  const found = new Map<string, Found>();
  const pending = new Set<string>();
  const newestFirst = jobs.filter(({ week }) => week.id === weekId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const job of newestFirst) {
    for (const { ingredientId } of job.items) {
      if (found.has(ingredientId) || pending.has(ingredientId)) continue;
      const result = job.found[ingredientId];
      if (result) found.set(ingredientId, result);
      else if (jobState(job, now) === 'running') pending.add(ingredientId);
    }
  }
  const lookup = newestFirst.find(({ kind }) => kind === 'lookup') ?? null;
  return { found, pending, lookup };
};

export type Finds = ReturnType<typeof latestFinds>;

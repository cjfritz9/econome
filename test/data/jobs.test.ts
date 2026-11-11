import { describe, expect, it } from 'vitest';
import { isExpired, jobError, jobState, latestFinds, readJob, type Job } from '../../src/data/jobs.ts';

const started = '2026-11-10T18:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(started) + minutes * 60 * 1000);

const found = (productId: string) => ({ suggestions: [{ productId, name: `Product ${productId}`, size: null, packages: null, vegan: { verdict: 'vegan' as const, reasons: [] }, why: [] }], excluded: [] });

const job = (id: string, fields: Partial<Job> = {}): Job =>
  readJob({
    id,
    data: {
      kind: 'lookup',
      state: 'running',
      week: { id: '2026-W46', start: '2026-11-09', end: '2026-11-15' },
      retailer: 'Wegmans',
      items: [
        { ingredientId: 'lemon', ingredient: 'lemon', term: 'lemon' },
        { ingredientId: 'garlic', ingredient: 'garlic', term: 'garlic' },
      ],
      startedAt: started,
      by: 'uid1',
      ...fields,
    },
  });

describe('jobState', () => {
  it("reads a running job that hasn't reported in 20 minutes as failed, saying so", () => {
    expect(jobState(job('a'), at(19))).toBe('running');
    expect(jobState(job('a'), at(21))).toBe('failed');
    expect(jobError(job('a'), at(21))).toMatch(/didn't report back within 20 minutes/);
    expect(jobState(job('a', { state: 'done' }), at(60))).toBe('done');
  });

  it('lets a job last a day', () => {
    expect(isExpired(job('a'), at(23 * 60))).toBe(false);
    expect(isExpired(job('a'), at(25 * 60))).toBe(true);
  });
});

describe('latestFinds', () => {
  it("takes each item's newest results for the week, and marks items a running job still owes as pending", () => {
    const older = job('older', { state: 'done', startedAt: '2026-11-10T17:00:00.000Z', found: { lemon: found('1'), garlic: found('2') } });
    const newer = job('newer', { startedAt: '2026-11-10T18:00:00.000Z', found: { lemon: found('3') } });
    const otherWeek = job('other', { week: { id: '2026-W47', start: '2026-11-16', end: '2026-11-22' }, found: { lemon: found('9') } });

    const finds = latestFinds([older, otherWeek, newer], '2026-W46', at(5));

    expect(finds.found.get('lemon')?.suggestions[0]?.productId).toBe('3');
    expect(finds.pending).toEqual(new Set(['garlic']));
    expect(finds.found.has('garlic')).toBe(false);
    expect(finds.lookup?.id).toBe('newer');
  });

  it("falls back to older results once the newer job stops owing them", () => {
    const older = job('older', { state: 'done', startedAt: '2026-11-10T17:00:00.000Z', found: { garlic: found('2') } });
    const newer = job('newer', { state: 'done', found: { lemon: found('3') } });

    expect(latestFinds([older, newer], '2026-W46', at(5)).found.get('garlic')?.suggestions[0]?.productId).toBe('2');
  });
});

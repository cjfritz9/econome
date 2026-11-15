import { describe, expect, it } from 'vitest';
import type { CatalogRunRecord } from '../../src/data/hungryroot-catalog.ts';
import { setup } from './harness.ts';

const counts = {
  read: 6542,
  of: 6542,
  complete: true,
  added: 0,
  updated: 3,
  unchanged: 6539,
  back: 0,
  gone: 1,
  products: 988,
  imageHostsLeftOff: [],
};

const runs: CatalogRunRecord[] = [
  { at: new Date('2026-12-01T09:00:00Z'), seconds: 150, error: null, counts },
  { at: new Date('2026-11-01T09:00:00Z'), seconds: 4, error: "Hungryroot's public catalog answered 503.", counts: null },
];

describe('GET /api/hungryroot/runs', () => {
  it('lists the catalog copy runs, newest first, failures included', async () => {
    const { status, body } = await setup({ catalogRuns: runs }).call('GET', '/hungryroot/runs');

    expect(status).toBe(200);
    expect(body).toEqual({
      runs: [
        { at: '2026-12-01T09:00:00.000Z', seconds: 150, ok: true, error: null, counts },
        { at: '2026-11-01T09:00:00.000Z', seconds: 4, ok: false, error: "Hungryroot's public catalog answered 503.", counts: null },
      ],
    });
  });

  it('takes a limit, and refuses one outside 1 to 24', async () => {
    const harness = setup({ catalogRuns: runs });

    expect(((await harness.call('GET', '/hungryroot/runs?limit=1')).body.runs as unknown[]).length).toBe(1);
    expect((await harness.call('GET', '/hungryroot/runs?limit=99')).status).toBe(400);
  });
});

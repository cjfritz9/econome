import { describe, expect, it } from 'vitest';
import type { Access } from '../../src/data/access.ts';
import type { HouseholdRecord, Households } from '../../src/data/household.ts';
import { emptyInstacartSection, type InstacartSection, type Weeks } from '../../src/data/weeks.ts';
import { createApp } from '../../src/http/app.ts';
import type { RoutineTrigger } from '../../src/sources/routines.ts';
import {
  answeringClaude,
  fakeFoodData,
  memoryDecisions,
  memoryIngredients,
  memoryJobs,
  memoryNotes,
  memoryParsedLines,
  memoryProductMemory,
  memoryVeganLine,
} from '../fakes.ts';

const MISE = 'https://mise.example.com';
const SECRET = 'a-routine-secret-at-least-32-characters-long';
const FILL_ROUTINE: RoutineTrigger = { url: 'https://api.example.com/routines/fill/fire', token: 'routine-token' };

const home: HouseholdRecord = {
  id: 'h1',
  name: 'Home',
  members: ['uid1', 'uid2'],
  econome: { timezone: 'America/New_York', instacart: { retailer: 'Wegmans' } },
};

const households: Households = {
  findUserHouseholdId: async (uid) => ({ uid1: 'h1', uid2: 'h1', uid3: 'h1' })[uid],
  findHousehold: async (id) => (id === 'h1' ? home : undefined),
  findMemberProfiles: async (uids) => uids.map((uid) => ({ uid, name: `Member ${uid}` })),
  updateSettings: async () => undefined,
};

const access: Access = { featuresOf: async (uid) => (uid === 'uid2' ? [] : ['econome']) };

const approved = (): InstacartSection => ({
  ...emptyInstacartSection(),
  retailer: 'Wegmans',
  approved: {
    lines: [
      { ingredient: 'extra-firm tofu', productId: '111', quantity: 1, name: 'Organic Extra Firm Tofu' },
      { ingredient: 'firm tofu', productId: '111', quantity: 1, name: 'Organic Extra Firm Tofu' },
      { ingredient: 'lemon', productId: '222', quantity: 2, name: 'Lemons' },
    ],
    listHash: 'hash',
    by: 'uid1',
  },
});

const setup = ({ sections = {}, fillRoutine = FILL_ROUTINE }: { sections?: Record<string, InstacartSection>; fillRoutine?: RoutineTrigger | null } = {}) => {
  const saved = new Map<string, InstacartSection>(Object.entries(sections));
  const fired: Array<{ trigger: RoutineTrigger; payload: unknown }> = [];
  const weeks: Weeks = {
    findWeekDocs: async (householdId, weekIds) =>
      weekIds.flatMap((id) => {
        const section = saved.get(`${householdId}/${id}`);
        return section ? [{ id, data: { meals: [], instacart: section } }] : [];
      }),
    savePlan: async () => undefined,
    saveHave: async () => undefined,
    saveHungryroot: async () => undefined,
    lockBox: async () => undefined,
    saveInstacart: async (householdId, weekId, section) => {
      saved.set(`${householdId}/${weekId}`, section);
    },
  };
  const app = createApp({
    verifier: {
      uidOf: async (token) => ({ 'token-1': 'uid1', 'token-2': 'uid2', 'token-3': 'uid3' })[token] ?? Promise.reject(new Error('bad token')),
    },
    access,
    households,
    spend: { spentOn: async () => 0.01234 },
    weeks,
    recipes: { listRecipeDocs: async () => [] },
    parsedLines: memoryParsedLines().store,
    ingredients: memoryIngredients().store,
    notes: memoryNotes().store,
    claude: answeringClaude(() => ({})).claude,
    fdc: fakeFoodData({}).foodData,
    productMemory: memoryProductMemory().store,
    veganLine: memoryVeganLine().store,
    decisions: memoryDecisions().store,
    jobs: memoryJobs().store,
    researchRoutine: null,
    routines: {
      fire: async (trigger, payload) => {
        fired.push({ trigger, payload });
        return { sessionId: 'cse_1', sessionUrl: 'https://claude.example.com/code/cse_1' };
      },
    },
    fillRoutine,
    routineSecret: SECRET,
    allowedOrigins: [MISE],
  });
  return { app, saved, fired };
};

const signedIn = (token: string, init: RequestInit = {}) => ({ ...init, headers: { Authorization: `Bearer ${token}` } });

const fromRoutine = (body: unknown, secret = SECRET) => ({
  method: 'POST',
  headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('the HTTP server', () => {
  it('answers the health check without a sign-in', async () => {
    const response = await setup().app.request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('gives a signed-in member their household, as get_household does', async () => {
    const response = await setup().app.request('/api/household', signedIn('token-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'h1',
      members: [{ uid: 'uid1' }, { uid: 'uid2' }],
      settings: { timezone: 'America/New_York', dailyClaudeCapUsd: 1 },
      claudeSpendToday: { usd: 0.0123, cap: 1 },
    });
  });

  it.each([
    ['no sign-in', {}],
    ['a sign-in that fails verification', signedIn('forged')],
  ])('refuses %s with 401', async (_label, init) => {
    const response = await setup().app.request('/api/household', init);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: expect.stringMatching(/sign/i) });
  });

  it.each([
    ['an account without the econome feature', 'token-2', /"econome" feature/],
    ["someone whose profile points at a household they aren't in", 'token-3', /not a member/],
  ])('refuses %s with 403 and the reason', async (_label, token, reason) => {
    const response = await setup().app.request('/api/household', signedIn(token));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: expect.stringMatching(reason) });
  });

  const elsewhere = 'http://localhost:3000';
  const fromOrigin = (app: ReturnType<typeof setup>['app'], origin: string, { method = 'GET', site = 'cross-site' } = {}) =>
    app.request('/api/household', {
      method,
      headers: { Origin: origin, 'Sec-Fetch-Site': site, Authorization: 'Bearer token-1', 'Access-Control-Request-Method': 'GET' },
    });

  it("serves Mise's origin, and refuses a browser on any other with a sentence the page can read", async () => {
    const { app } = setup();

    expect((await fromOrigin(app, MISE, { method: 'OPTIONS' })).headers.get('access-control-allow-origin')).toBe(MISE);
    const served = await fromOrigin(app, MISE);
    expect(served.status).toBe(200);
    expect(served.headers.get('access-control-allow-origin')).toBe(MISE);

    expect((await fromOrigin(app, elsewhere, { method: 'OPTIONS' })).status).toBe(204);
    const refused = await fromOrigin(app, elsewhere);
    expect(refused.status).toBe(403);
    expect(refused.headers.get('access-control-allow-origin')).toBe(elsewhere);
    expect(await refused.json()).toEqual({ error: "Économe doesn't accept requests from http://localhost:3000." });
  });

  it("serves a request a dev server proxied from its own origin, without letting a browser read it cross-origin", async () => {
    const { app } = setup();

    for (const site of ['same-origin', 'none']) {
      const proxied = await fromOrigin(app, elsewhere, { method: 'GET', site });
      expect(proxied.status).toBe(200);
      expect(proxied.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('serves requests without an Origin, such as curl or a routine', async () => {
    const { app } = setup();

    expect((await app.request('/api/household', signedIn('token-1'))).status).toBe(200);
  });
});

describe('starting a fill', () => {
  const fill = (app: ReturnType<typeof setup>['app'], date = '2026-11-11') =>
    app.request(`/api/weeks/${date}/instacart/fill`, signedIn('token-1', { method: 'POST' }));

  it("starts the fill routine with the week's approved lines, combined per product, and remembers the fill", async () => {
    const { app, saved, fired } = setup({ sections: { 'h1/2026-W46': approved() } });

    const response = await fill(app);

    expect(response.status).toBe(202);
    const body = (await response.json()) as { fillId: string };
    expect(body).toEqual({ week: '2026-W46', fillId: expect.stringMatching(/^h1\.2026-11-09\./), run: 'https://claude.example.com/code/cse_1' });
    expect(fired).toEqual([
      {
        trigger: FILL_ROUTINE,
        payload: {
          fill_id: body.fillId,
          carts: [{ retailer: 'Wegmans', items: [{ product_id: '111', quantity: 2 }, { product_id: '222', quantity: 2 }] }],
        },
      },
    ]);
    expect(saved.get('h1/2026-W46')?.sent).toEqual({ fillId: body.fillId, sessionId: 'cse_1', by: 'uid1', error: null });
  });

  it("refuses a week that isn't approved, without starting anything", async () => {
    const { app, fired } = setup({ sections: { 'h1/2026-W46': emptyInstacartSection() } });

    const response = await fill(app);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "2026-W46's Instacart cart isn't approved yet." });
    expect(fired).toEqual([]);
  });

  it('says so when the fill routine is not set up, or the date is not a date', async () => {
    expect((await fill(setup({ sections: { 'h1/2026-W46': approved() }, fillRoutine: null }).app)).status).toBe(503);
    expect((await fill(setup().app, 'next-week')).status).toBe(400);
  });
});

describe("receiving a fill's result", () => {
  const sentWeek = (fillId: string): InstacartSection => ({ ...approved(), sent: { fillId, sessionId: 'cse_1', by: 'uid1', error: null } });
  const FILL_ID = 'h1.2026-11-09.0f8fad5b-d9cb-469f-a165-70867728950e';
  const cart = (lines: Array<{ product_id: string; quantity: number; name?: string }>) => ({ fill_id: FILL_ID, carts: [{ retailer: 'wegmans', lines }], error: null });

  it('records the cart the routine read back and compares it with the approval', async () => {
    const { app, saved } = setup({ sections: { 'h1/2026-W46': sentWeek(FILL_ID) } });

    const response = await app.request(
      '/routines/instacart-fill/result',
      fromRoutine(cart([{ product_id: '111', quantity: 2, name: 'Organic Extra Firm Tofu' }, { product_id: '333', quantity: 1, name: 'Cucumber' }])),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      week: '2026-W46',
      matches: false,
      missing: [{ productId: '222', quantity: 2, for: ['Lemons'] }],
      differs: [],
      extra: [{ productId: '333', quantity: 1, name: 'Cucumber' }],
    });
    expect(saved.get('h1/2026-W46')?.filled).toEqual({
      by: 'uid1',
      fillId: FILL_ID,
      lines: [
        { productId: '111', quantity: 2, name: 'Organic Extra Firm Tofu' },
        { productId: '333', quantity: 1, name: 'Cucumber' },
      ],
      checkoutUrl: null,
    });
  });

  it("keeps the cart's checkout link, without Instacart's tracking, and ignores any other address", async () => {
    const withLink = (checkout_url: string) => ({ ...cart([{ product_id: '111', quantity: 2 }]), carts: [{ retailer: 'Wegmans', checkout_url, lines: [{ product_id: '111', quantity: 2 }] }] });
    const first = setup({ sections: { 'h1/2026-W46': sentWeek(FILL_ID) } });

    await first.app.request('/routines/instacart-fill/result', fromRoutine(withLink('https://www.instacart.com/store/checkout_v4?sid=1234&cartId=987&utm_source=fig_mcp_generic&utm_campaign=x')));
    expect(first.saved.get('h1/2026-W46')?.filled?.checkoutUrl).toBe('https://www.instacart.com/store/checkout_v4?sid=1234&cartId=987');

    const second = setup({ sections: { 'h1/2026-W46': sentWeek(FILL_ID) } });
    await second.app.request('/routines/instacart-fill/result', fromRoutine(withLink('https://instacart.example.com/checkout?sid=1234')));
    expect(second.saved.get('h1/2026-W46')?.filled?.checkoutUrl).toBeNull();
  });

  it('accepts each result once', async () => {
    const { app } = setup({ sections: { 'h1/2026-W46': sentWeek(FILL_ID) } });
    const result = cart([{ product_id: '111', quantity: 2 }, { product_id: '222', quantity: 2 }]);

    expect((await app.request('/routines/instacart-fill/result', fromRoutine(result))).status).toBe(200);
    expect((await app.request('/routines/instacart-fill/result', fromRoutine(result))).status).toBe(409);
  });

  it('keeps an error the routine reports, so the household sees why nothing was filled', async () => {
    const { app, saved } = setup({ sections: { 'h1/2026-W46': sentWeek(FILL_ID) } });

    const response = await app.request('/routines/instacart-fill/result', fromRoutine({ fill_id: FILL_ID, carts: [], error: 'connector missing' }));

    expect(response.status).toBe(200);
    expect(saved.get('h1/2026-W46')?.sent?.error).toBe('connector missing');
    expect(saved.get('h1/2026-W46')?.filled).toBeNull();
  });

  it.each([
    ['a wrong secret', fromRoutine(cart([]), 'not-the-secret'), 401],
    ['no secret', { method: 'POST', body: JSON.stringify(cart([])) }, 401],
    ['a fill ID Économe never sent', fromRoutine({ ...cart([]), fill_id: 'h1.2026-11-09.11111111-2222-4333-8444-555555555555' }), 404],
    ['something that is not a fill ID', fromRoutine({ ...cart([]), fill_id: 'whatever' }), 400],
    ['a body that is not a result', fromRoutine({ hello: 'there' }), 400],
  ])('refuses %s', async (_label, init, status) => {
    const { app, saved } = setup({ sections: { 'h1/2026-W46': sentWeek(FILL_ID) } });

    const response = await app.request('/routines/instacart-fill/result', init);

    expect(response.status).toBe(status);
    expect(saved.get('h1/2026-W46')?.filled).toBeNull();
  });
});

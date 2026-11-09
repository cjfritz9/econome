import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { krogerSession, NOT_CONNECTED } from '../../src/core/kroger-session.ts';
import { seal, unseal } from '../../src/core/secrets.ts';
import type { StoreAccount, StoreAccounts } from '../../src/data/store-accounts.ts';
import type { KrogerAccount } from '../../src/sources/kroger-account.ts';
import { household } from '../fakes.ts';

const key = randomBytes(32);

const memoryAccounts = (initial: StoreAccount | null = null) => {
  let stored = initial;
  const accounts: StoreAccounts = {
    find: async () => stored,
    save: async (_id, account) => {
      stored = account;
    },
    remove: async () => {
      stored = null;
    },
    claim: async (_id, holder, now, leaseMs) => {
      if (!stored) return null;
      if (stored.lease && stored.lease.holder !== holder && stored.lease.until > now) return 'busy';
      stored = { ...stored, lease: { holder, until: now + leaseMs } };
      return stored;
    },
    release: async (_id, holder, refresh) => {
      if (stored?.lease?.holder === holder) stored = { ...stored, refresh, lease: null };
    },
  };
  return { accounts, current: () => stored };
};

const fakeKroger = (refreshTokens: string[] = []): KrogerAccount & { refreshed: string[] } => {
  const refreshed: string[] = [];
  return {
    refreshed,
    signInUrl: () => 'https://example.test',
    exchange: async () => ({ accessToken: 'first-access', refreshToken: 'first-refresh', expiresIn: 1800 }),
    refresh: async (token) => {
      refreshed.push(token);
      const next = refreshTokens.shift();
      if (!next) throw new Error('Kroger refused the sign-in');
      return { accessToken: `access-for-${next}`, refreshToken: next, expiresIn: 1800 };
    },
    addToCart: async () => ({ status: 'sent' }),
  };
};

const connected = (refresh: string, overrides: Partial<StoreAccount> = {}): StoreAccount => ({
  connectedBy: 'uid1',
  connectedAt: '2026-11-09T12:00:00.000Z',
  refresh: seal(key, refresh),
  lease: null,
  ...overrides,
});

describe('krogerSession', () => {
  it('saves the sign-in sealed, never as plain text, and uses its access token straight away', async () => {
    const { accounts, current } = memoryAccounts();
    const kroger = fakeKroger();
    const session = krogerSession({ account: kroger, accounts, key, holder: 'me' });

    await session.connect('h1', 'uid1', 'code');

    expect(JSON.stringify(current())).not.toContain('first-refresh');
    expect(unseal(key, current()!.refresh)).toBe('first-refresh');
    expect(await session.accessToken(household)).toBe('first-access');
    expect(kroger.refreshed).toEqual([]);
  });

  it('renews with the saved refresh token, saving the new one Kroger returns', async () => {
    const { accounts, current } = memoryAccounts(connected('saved'));
    const kroger = fakeKroger(['renewed']);

    const token = await krogerSession({ account: kroger, accounts, key, holder: 'me' }).accessToken(household);

    expect(token).toBe('access-for-renewed');
    expect(kroger.refreshed).toEqual(['saved']);
    expect(unseal(key, current()!.refresh)).toBe('renewed');
    expect(current()?.lease).toBeNull();
  });

  it('waits while another process holds the lease, then gives up', async () => {
    const { accounts } = memoryAccounts(connected('saved', { lease: { holder: 'other', until: Date.now() + 60_000 } }));
    const session = krogerSession({ account: fakeKroger(['x']), accounts, key, holder: 'me', pause: async () => {} });

    await expect(session.accessToken(household)).rejects.toThrow(/Another Économe process/);
  });

  it('removes a connection made by someone no longer in the household', async () => {
    const { accounts, current } = memoryAccounts(connected('saved', { connectedBy: 'gone' }));

    await expect(krogerSession({ account: fakeKroger(['x']), accounts, key, holder: 'me' }).accessToken(household)).rejects.toThrow(
      /no longer in the household/,
    );
    expect(current()).toBeNull();
  });

  it('keeps the old token and frees the lease when Kroger refuses the renewal', async () => {
    const { accounts, current } = memoryAccounts(connected('saved'));

    await expect(krogerSession({ account: fakeKroger([]), accounts, key, holder: 'me' }).accessToken(household)).rejects.toThrow();
    expect(unseal(key, current()!.refresh)).toBe('saved');
    expect(current()?.lease).toBeNull();
  });

  it('says to connect when there is no connection', async () => {
    const { accounts } = memoryAccounts();

    await expect(krogerSession({ account: fakeKroger(), accounts, key, holder: 'me' }).accessToken(household)).rejects.toThrow(NOT_CONNECTED);
  });
});

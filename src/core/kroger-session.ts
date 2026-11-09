import type { Household } from '../data/household.ts';
import type { StoreAccounts } from '../data/store-accounts.ts';
import type { KrogerAccount } from '../sources/kroger-account.ts';
import { seal, unseal } from './secrets.ts';

const LEASE_MS = 30_000;
const TOKEN_MARGIN_MS = 60_000;
const CLAIM_ATTEMPTS = 5;

export const NOT_CONNECTED = "The household's Kroger account isn't connected yet; connect it with connect_kroger.";

export const krogerSession = ({
  account,
  accounts,
  key,
  holder,
  now = () => Date.now(),
  pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  account: KrogerAccount;
  accounts: StoreAccounts;
  key: Buffer;
  holder: string;
  now?: () => number;
  pause?: (ms: number) => Promise<unknown>;
}) => {
  const cache = new Map<string, { token: string; expiresAt: number }>();

  const remember = (householdId: string, token: string, expiresIn: number) =>
    cache.set(householdId, { token, expiresAt: now() + expiresIn * 1000 });

  return {
    connect: async (householdId: string, uid: string, code: string) => {
      const tokens = await account.exchange(code);
      await accounts.save(householdId, {
        connectedBy: uid,
        connectedAt: new Date(now()).toISOString(),
        refresh: seal(key, tokens.refreshToken),
        lease: null,
      });
      remember(householdId, tokens.accessToken, tokens.expiresIn);
    },

    disconnect: async (householdId: string) => {
      cache.delete(householdId);
      await accounts.remove(householdId);
    },

    accessToken: async (household: Household) => {
      const cached = cache.get(household.id);
      if (cached && cached.expiresAt - TOKEN_MARGIN_MS > now()) return cached.token;

      for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
        const claimed = await accounts.claim(household.id, holder, now(), LEASE_MS);
        if (claimed === null) throw new Error(NOT_CONNECTED);
        if (claimed === 'busy') {
          await pause(1_000);
          continue;
        }
        if (!household.members.includes(claimed.connectedBy)) {
          await accounts.remove(household.id);
          throw new Error(
            'The person who connected Kroger is no longer in the household, so the connection was removed. A current member can connect it again with connect_kroger.',
          );
        }
        const tokens = await account.refresh(unseal(key, claimed.refresh)).catch(async (error: unknown) => {
          await accounts.release(household.id, holder, claimed.refresh);
          throw error;
        });
        await accounts.release(household.id, holder, seal(key, tokens.refreshToken));
        remember(household.id, tokens.accessToken, tokens.expiresIn);
        return tokens.accessToken;
      }
      throw new Error('Another Économe process is renewing the Kroger sign-in; try again in a moment.');
    },
  };
};

export type KrogerSession = ReturnType<typeof krogerSession>;

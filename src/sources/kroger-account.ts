import * as z from 'zod';

const API = 'https://api.kroger.com/v1';
const SCOPES = 'cart.basic:write product.compact profile.compact';
const CART_TIMEOUT_MS = 15_000;

export const KROGER_REDIRECT = 'http://localhost:8765/kroger/callback';

export interface KrogerTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type CartOutcome = { status: 'sent' } | { status: 'unknown'; message: string } | { status: 'failed'; message: string };

export type Modality = 'PICKUP' | 'DELIVERY';

export interface KrogerAccount {
  signInUrl: (state: string) => string;
  exchange: (code: string) => Promise<KrogerTokens>;
  refresh: (refreshToken: string) => Promise<KrogerTokens>;
  addToCart: (accessToken: string, line: { upc: string; quantity: number }, modality?: Modality) => Promise<CartOutcome>;
}

const TokensSchema = z.object({ access_token: z.string(), refresh_token: z.string(), expires_in: z.number() });

export class KrogerSignInError extends Error {}

export const krogerAccount = (
  { clientId, clientSecret, version }: { clientId: string; clientSecret: string; version: string },
  fetchJson: typeof fetch = fetch,
): KrogerAccount => {
  const userAgent = `Econome/${version} (household grocery planner)`;

  const tokens = async (grant: Record<string, string>) => {
    const response = await fetchJson(`${API}/connect/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': userAgent,
      },
      body: new URLSearchParams(grant),
    });
    if (!response.ok) {
      throw new KrogerSignInError(`Kroger refused the sign-in (${response.status}); connect the Kroger account again with connect_kroger.`);
    }
    const { access_token, refresh_token, expires_in } = TokensSchema.parse(await response.json());
    return { accessToken: access_token, refreshToken: refresh_token, expiresIn: expires_in };
  };

  return {
    signInUrl: (state) =>
      `${API}/connect/oauth2/authorize?${new URLSearchParams({
        scope: SCOPES,
        response_type: 'code',
        client_id: clientId,
        redirect_uri: KROGER_REDIRECT,
        state,
      })}`,

    exchange: (code) => tokens({ grant_type: 'authorization_code', code, redirect_uri: KROGER_REDIRECT }),

    refresh: (refreshToken) => tokens({ grant_type: 'refresh_token', refresh_token: refreshToken }),

    addToCart: async (accessToken, { upc, quantity }, modality) => {
      try {
        const response = await fetchJson(`${API}/cart/add`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'user-agent': userAgent },
          body: JSON.stringify({ items: [{ upc, quantity, ...(modality && { modality }) }] }),
          signal: AbortSignal.timeout(CART_TIMEOUT_MS),
        });
        if (response.ok) return { status: 'sent' };
        if (response.status >= 500) return { status: 'unknown', message: `Kroger answered ${response.status}; check the cart before sending it again` };
        return { status: 'failed', message: `Kroger refused it (${response.status})` };
      } catch (error) {
        return { status: 'unknown', message: `${error instanceof Error ? error.message : String(error)}; check the cart before sending it again` };
      }
    },
  };
};

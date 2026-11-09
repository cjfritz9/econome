import { describe, expect, it } from 'vitest';
import { KROGER_REDIRECT, krogerAccount } from '../../src/sources/kroger-account.ts';

const credentials = { clientId: 'id', clientSecret: 'secret', version: '1' };

const answering = (respond: (url: URL, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchJson = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { fetchJson, calls };
};

const tokens = () => new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 1800 }));

describe('krogerAccount', () => {
  it('builds a sign-in link for the cart, product and profile scopes, back to this computer', () => {
    const url = new URL(krogerAccount(credentials).signInUrl('state123'));

    expect(Object.fromEntries(url.searchParams)).toEqual({
      scope: 'cart.basic:write product.compact profile.compact',
      response_type: 'code',
      client_id: 'id',
      redirect_uri: KROGER_REDIRECT,
      state: 'state123',
    });
  });

  it('exchanges a code and refreshes, reading both tokens', async () => {
    const { fetchJson, calls } = answering(tokens);
    const account = krogerAccount(credentials, fetchJson);

    expect(await account.exchange('code1')).toEqual({ accessToken: 'access', refreshToken: 'refresh', expiresIn: 1800 });
    await account.refresh('old');

    expect(String(calls[0]?.init?.body)).toBe(`grant_type=authorization_code&code=code1&redirect_uri=${encodeURIComponent(KROGER_REDIRECT)}`);
    expect(String(calls[1]?.init?.body)).toBe('grant_type=refresh_token&refresh_token=old');
  });

  it('says to connect again when Kroger refuses the sign-in', async () => {
    const { fetchJson } = answering(() => new Response('{}', { status: 400 }));

    await expect(krogerAccount(credentials, fetchJson).refresh('old')).rejects.toThrow(/connect the Kroger account again/);
  });

  it('adds one line to the cart, with the modality when the household set one', async () => {
    const { fetchJson, calls } = answering(() => new Response(null, { status: 204 }));

    const outcome = await krogerAccount(credentials, fetchJson).addToCart('access', { upc: '0001111091342', quantity: 3 }, 'PICKUP');

    expect(outcome).toEqual({ status: 'sent' });
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ items: [{ upc: '0001111091342', quantity: 3, modality: 'PICKUP' }] });
  });

  it("treats a server error or a timeout as unknown, and a refusal as failed", async () => {
    const line = { upc: '0001111091342', quantity: 1 };
    const serverError = answering(() => new Response(null, { status: 503 }));
    const timeout = answering(() => Promise.reject(new Error('The operation was aborted due to timeout')));
    const refused = answering(() => new Response(null, { status: 401 }));

    expect((await krogerAccount(credentials, serverError.fetchJson).addToCart('a', line)).status).toBe('unknown');
    expect(await krogerAccount(credentials, timeout.fetchJson).addToCart('a', line)).toMatchObject({ status: 'unknown', message: expect.stringMatching(/check the cart/) });
    expect(await krogerAccount(credentials, refused.fetchJson).addToCart('a', line)).toEqual({ status: 'failed', message: 'Kroger refused it (401)' });
  });
});

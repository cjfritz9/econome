import { describe, expect, it } from 'vitest';
import { signInListener, type PendingSignIn } from '../../src/mcp/kroger-signin.ts';

const callback = (state: string, extra = '&code=abc') => `http://localhost:8765/kroger/callback?state=${state}${extra}`;

describe('signInListener', () => {
  it('finishes a sign-in from the address the browser landed on, once', async () => {
    const finished: [PendingSignIn, string][] = [];
    const listener = signInListener(async (signIn, code) => {
      finished.push([signIn, code]);
    });
    const { state } = await listener.start('h1', 'uid1');

    await listener.finishFromUrl(callback(state));

    expect(finished).toEqual([[expect.objectContaining({ householdId: 'h1', uid: 'uid1' }), 'abc']]);
    await expect(listener.finishFromUrl(callback(state))).rejects.toThrow(/out of date/);
  });

  it("refuses an unknown or expired sign-in, and one Kroger didn't finish", async () => {
    let now = 0;
    const listener = signInListener(async () => {}, () => now);
    const { state } = await listener.start('h1', 'uid1');

    await expect(listener.finishFromUrl(callback('forged'))).rejects.toThrow(/out of date/);
    await expect(listener.finishFromUrl(callback(state, '&error=access_denied'))).rejects.toThrow(
      /didn't finish the sign-in \(access_denied\)/,
    );
    now = 11 * 60_000;
    await expect(listener.finishFromUrl(callback(state))).rejects.toThrow(/out of date/);
    listener.stop();
  });

  it('answers the redirect on this computer and finishes the sign-in there', async () => {
    const finished: string[] = [];
    const listener = signInListener(async (_signIn, code) => {
      finished.push(code);
    });
    const { state, listening } = await listener.start('h1', 'uid1');

    expect(listening).toBe(true);
    const page = await fetch(callback(state, '&code=xyz'));

    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/Kroger is connected/);
    expect(finished).toEqual(['xyz']);
  });
});

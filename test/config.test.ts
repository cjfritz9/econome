import { describe, expect, it } from 'vitest';
import { loadConfig, loadHttpConfig } from '../src/config.ts';

describe('loadHttpConfig', () => {
  it("needs only the Firebase project, listening on Cloud Run's port 8080 by default", () => {
    expect(loadHttpConfig({ FIREBASE_PROJECT_ID: 'project-1' })).toEqual({
      firebaseProjectId: 'project-1',
      port: 8080,
      allowedOrigins: [],
      fillRoutine: null,
      routineSecret: null,
    });
  });

  it('reads the port and a comma-separated list of allowed origins', () => {
    const config = loadHttpConfig({ FIREBASE_PROJECT_ID: 'project-1', PORT: '3001', ECONOME_ALLOWED_ORIGINS: 'https://a.example.com, http://localhost:3000' });

    expect(config).toMatchObject({ port: 3001, allowedOrigins: ['https://a.example.com', 'http://localhost:3000'] });
  });

  it('reads the fill routine and the routine secret, both optional', () => {
    const base = { FIREBASE_PROJECT_ID: 'project-1' };

    expect(loadHttpConfig(base)).toMatchObject({ fillRoutine: null, routineSecret: null });
    expect(
      loadHttpConfig({
        ...base,
        INSTACART_FILL_CART_ROUTINE_URL: 'https://api.example.com/fire',
        INSTACART_FILL_CART_ROUTINE_TOKEN: 'token',
        ECONOME_ROUTINE_SECRET: 'x'.repeat(64),
      }),
    ).toMatchObject({ fillRoutine: { url: 'https://api.example.com/fire', token: 'token' }, routineSecret: 'x'.repeat(64) });
  });

  it('refuses half a routine, a plain-HTTP routine address or a short secret', () => {
    const base = { FIREBASE_PROJECT_ID: 'project-1' };

    expect(() => loadHttpConfig({ ...base, INSTACART_FILL_CART_ROUTINE_URL: 'https://api.example.com/fire' })).toThrow(/both/);
    expect(() => loadHttpConfig({ ...base, INSTACART_FILL_CART_ROUTINE_URL: 'http://api.example.com/fire', INSTACART_FILL_CART_ROUTINE_TOKEN: 't' })).toThrow(
      /INSTACART_FILL_CART_ROUTINE_URL/,
    );
    expect(() => loadHttpConfig({ ...base, ECONOME_ROUTINE_SECRET: 'short' })).toThrow(/ECONOME_ROUTINE_SECRET/);
  });

  it('refuses an origin that is not a URL, naming the setting', () => {
    expect(() => loadHttpConfig({ FIREBASE_PROJECT_ID: 'project-1', ECONOME_ALLOWED_ORIGINS: 'mise' })).toThrow(/ECONOME_ALLOWED_ORIGINS/);
  });
});

describe('loadConfig', () => {
  it('still needs the acting account for the stdio server', () => {
    expect(() => loadConfig({ FIREBASE_PROJECT_ID: 'project-1', ANTHROPIC_API_KEY: 'k', FDC_API_KEY: 'k' })).toThrow(/ECONOME_ACTING_EMAIL/);
  });
});

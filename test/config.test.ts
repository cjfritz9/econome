import { describe, expect, it } from 'vitest';
import { loadConfig, loadHttpConfig } from '../src/config.ts';

describe('loadHttpConfig', () => {
  const base = { FIREBASE_PROJECT_ID: 'project-1', ANTHROPIC_API_KEY: 'anthropic-key', FDC_API_KEY: 'fdc-key' };

  it("needs the Firebase project and the Claude and FoodData Central keys, listening on Cloud Run's port 8080 by default", () => {
    expect(loadHttpConfig(base)).toEqual({
      firebaseProjectId: 'project-1',
      anthropicApiKey: 'anthropic-key',
      fdcApiKey: 'fdc-key',
      port: 8080,
      allowedOrigins: [],
      fillRoutine: null,
      researchRoutine: null,
      routineSecret: null,
    });
    expect(() => loadHttpConfig({ FIREBASE_PROJECT_ID: 'project-1' })).toThrow(/ANTHROPIC_API_KEY[\s\S]*FDC_API_KEY/);
  });

  it('reads the port and a comma-separated list of allowed origins', () => {
    const config = loadHttpConfig({ ...base, PORT: '3001', ECONOME_ALLOWED_ORIGINS: 'https://a.example.com, http://localhost:3000' });

    expect(config).toMatchObject({ port: 3001, allowedOrigins: ['https://a.example.com', 'http://localhost:3000'] });
  });

  it('reads the fill routine and the routine secret, both optional', () => {
    expect(loadHttpConfig(base)).toMatchObject({ fillRoutine: null, routineSecret: null });
    expect(
      loadHttpConfig({
        ...base,
        INSTACART_FILL_CART_ROUTINE_URL: 'https://api.example.com/fire',
        INSTACART_FILL_CART_ROUTINE_TOKEN: 'token',
        INSTACART_RESEARCH_ROUTINE_URL: 'https://api.example.com/research',
        INSTACART_RESEARCH_ROUTINE_TOKEN: 'research-token',
        ECONOME_ROUTINE_SECRET: 'x'.repeat(64),
      }),
    ).toMatchObject({
      fillRoutine: { url: 'https://api.example.com/fire', token: 'token' },
      researchRoutine: { url: 'https://api.example.com/research', token: 'research-token' },
      routineSecret: 'x'.repeat(64),
    });
  });

  it('refuses half a routine, a plain-HTTP routine address or a short secret', () => {
    expect(() => loadHttpConfig({ ...base, INSTACART_FILL_CART_ROUTINE_URL: 'https://api.example.com/fire' })).toThrow(/both/);
    expect(() => loadHttpConfig({ ...base, INSTACART_RESEARCH_ROUTINE_TOKEN: 'research-token' })).toThrow(/INSTACART_RESEARCH_ROUTINE_URL and/);
    expect(() => loadHttpConfig({ ...base, INSTACART_FILL_CART_ROUTINE_URL: 'http://api.example.com/fire', INSTACART_FILL_CART_ROUTINE_TOKEN: 't' })).toThrow(
      /INSTACART_FILL_CART_ROUTINE_URL/,
    );
    expect(() => loadHttpConfig({ ...base, ECONOME_ROUTINE_SECRET: 'short' })).toThrow(/ECONOME_ROUTINE_SECRET/);
  });

  it('refuses an origin that is not a URL, naming the setting', () => {
    expect(() => loadHttpConfig({ ...base, ECONOME_ALLOWED_ORIGINS: 'mise' })).toThrow(/ECONOME_ALLOWED_ORIGINS/);
  });
});

describe('loadConfig', () => {
  it('still needs the acting account for the stdio server', () => {
    expect(() => loadConfig({ FIREBASE_PROJECT_ID: 'project-1', ANTHROPIC_API_KEY: 'k', FDC_API_KEY: 'k' })).toThrow(/ECONOME_ACTING_EMAIL/);
  });
});

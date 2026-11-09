import * as z from 'zod';

const EnvSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1),
  ECONOME_ACTING_EMAIL: z.email(),
  ANTHROPIC_API_KEY: z.string().min(1),
  FDC_API_KEY: z.string().min(1),
  KROGER_CLIENT_ID: z.string().min(1).optional(),
  KROGER_CLIENT_SECRET: z.string().min(1).optional(),
  ECONOME_TOKEN_KEY: z.string().min(1).optional(),
});

export interface Config {
  firebaseProjectId: string;
  actingEmail: string;
  anthropicApiKey: string;
  fdcApiKey: string;
  kroger: { clientId: string; clientSecret: string } | null;
  tokenKey: string | null;
}

export const loadConfig = (env: NodeJS.ProcessEnv): Config => {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Missing or invalid settings in app/.env:\n${z.prettifyError(parsed.error)}`);
  }
  return {
    firebaseProjectId: parsed.data.FIREBASE_PROJECT_ID,
    actingEmail: parsed.data.ECONOME_ACTING_EMAIL,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    fdcApiKey: parsed.data.FDC_API_KEY,
    kroger:
      parsed.data.KROGER_CLIENT_ID && parsed.data.KROGER_CLIENT_SECRET
        ? { clientId: parsed.data.KROGER_CLIENT_ID, clientSecret: parsed.data.KROGER_CLIENT_SECRET }
        : null,
    tokenKey: parsed.data.ECONOME_TOKEN_KEY ?? null,
  };
};

import * as z from 'zod';

const EnvSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1),
  ECONOME_ACTING_EMAIL: z.email(),
  ANTHROPIC_API_KEY: z.string().min(1),
  FDC_API_KEY: z.string().min(1),
});

export interface Config {
  firebaseProjectId: string;
  actingEmail: string;
  anthropicApiKey: string;
  fdcApiKey: string;
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
  };
};

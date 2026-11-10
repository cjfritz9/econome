import * as z from 'zod';
import type { RoutineTrigger } from './sources/routines.ts';

const DEFAULT_PORT = 8080;
const MIN_SECRET_LENGTH = 32;

const McpEnvSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1),
  ECONOME_ACTING_EMAIL: z.email(),
  ANTHROPIC_API_KEY: z.string().min(1),
  FDC_API_KEY: z.string().min(1),
});

const HttpEnvSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(DEFAULT_PORT),
  ECONOME_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((origins) => origins.split(',').map((origin) => origin.trim()).filter(Boolean))
    .pipe(z.array(z.url())),
  INSTACART_FILL_CART_ROUTINE_URL: z.url({ protocol: /^https$/ }).optional(),
  INSTACART_FILL_CART_ROUTINE_TOKEN: z.string().min(1).optional(),
  ECONOME_ROUTINE_SECRET: z.string().min(MIN_SECRET_LENGTH).optional(),
}).refine(
  (env) => Boolean(env.INSTACART_FILL_CART_ROUTINE_URL) === Boolean(env.INSTACART_FILL_CART_ROUTINE_TOKEN),
  { message: 'Set both INSTACART_FILL_CART_ROUTINE_URL and INSTACART_FILL_CART_ROUTINE_TOKEN, or neither' },
);

export interface Config {
  firebaseProjectId: string;
  actingEmail: string;
  anthropicApiKey: string;
  fdcApiKey: string;
}

export interface HttpConfig {
  firebaseProjectId: string;
  port: number;
  allowedOrigins: string[];
  fillRoutine: RoutineTrigger | null;
  routineSecret: string | null;
}

const parseEnv = <Schema extends z.ZodType>(schema: Schema, env: NodeJS.ProcessEnv): z.infer<Schema> => {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Missing or invalid settings in the environment (app/.env locally):\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};

export const loadConfig = (env: NodeJS.ProcessEnv): Config => {
  const parsed = parseEnv(McpEnvSchema, env);
  return {
    firebaseProjectId: parsed.FIREBASE_PROJECT_ID,
    actingEmail: parsed.ECONOME_ACTING_EMAIL,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    fdcApiKey: parsed.FDC_API_KEY,
  };
};

export const loadHttpConfig = (env: NodeJS.ProcessEnv): HttpConfig => {
  const parsed = parseEnv(HttpEnvSchema, env);
  const { INSTACART_FILL_CART_ROUTINE_URL: url, INSTACART_FILL_CART_ROUTINE_TOKEN: token } = parsed;
  return {
    firebaseProjectId: parsed.FIREBASE_PROJECT_ID,
    port: parsed.PORT,
    allowedOrigins: parsed.ECONOME_ALLOWED_ORIGINS,
    fillRoutine: url && token ? { url, token } : null,
    routineSecret: parsed.ECONOME_ROUTINE_SECRET ?? null,
  };
};

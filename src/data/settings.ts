import * as z from 'zod';
import { Weekday } from '../core/calendar.ts';
import { NotePath } from './notes.ts';

export const SETTINGS_FIELD = 'econome';
export const DEFAULT_DAILY_CLAUDE_CAP_USD = 1;
export const DEFAULT_PLANNING_DIRECTIVE = 'directives/general.md';

const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const SettingsSchema = z.object({
  timezone: z
    .string()
    .refine(isTimeZone, 'Unknown time zone')
    .optional()
    .describe('IANA time zone for the household, e.g. America/New_York'),
  dailyClaudeCapUsd: z
    .number()
    .positive()
    .optional()
    .describe(`Daily spending cap for Économe's own Claude calls, in US dollars (default ${DEFAULT_DAILY_CLAUDE_CAP_USD})`),
  weeklyCapUsd: z.number().positive().optional().describe('Weekly grocery budget the review compares against, in US dollars'),
  planningDirective: NotePath.refine((path) => path.startsWith('directives/'), 'A planning directive is a note under directives/')
    .optional()
    .describe(`The note under directives/ that planning and recipe suggestions follow (default ${DEFAULT_PLANNING_DIRECTIVE})`),
  hungryroot: z
    .object({
      deliveryDay: Weekday.optional(),
      cutoffDay: Weekday.optional(),
      cutoffTime: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM')
        .optional()
        .describe("Time the shopping window closes, 24-hour HH:MM in the household's time zone"),
    })
    .optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const parseSettings = (value: unknown): Settings => {
  const parsed = SettingsSchema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new Error(`Économe's settings on this household are invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};

export const withDefaults = (settings: Settings) => ({
  ...settings,
  dailyClaudeCapUsd: settings.dailyClaudeCapUsd ?? DEFAULT_DAILY_CLAUDE_CAP_USD,
  planningDirective: settings.planningDirective ?? DEFAULT_PLANNING_DIRECTIVE,
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const toUpdatePaths = (changes: Record<string, unknown>, prefix = SETTINGS_FIELD): Record<string, unknown> =>
  Object.entries(changes).reduce<Record<string, unknown>>((paths, [key, value]) => {
    if (value === undefined) return paths;
    const path = `${prefix}.${key}`;
    return isPlainObject(value) ? { ...paths, ...toUpdatePaths(value, path) } : { ...paths, [path]: value };
  }, {});

import * as z from 'zod';
import { Weekday } from '../core/calendar.ts';
import { NotePath } from './notes.ts';
import { MealTargets } from './weeks.ts';

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
  weeklyCapUsd: z
    .number()
    .positive()
    .optional()
    .describe(
      'Weekly grocery budget in US dollars, a warning only: when a week looks to run over it, say so, but never block, change or drop anything because of it',
    ),
  mealTargets: MealTargets.optional().describe(
    "Servings to plan in a usual week for each meal, one serving being one person's meal. Any week can set its own with plan_week",
  ),
  instacart: z
    .object({
      retailer: z
        .string()
        .min(1)
        .optional()
        .describe("The store the household shops on Instacart, by the name Instacart's connector uses, such as Wegmans"),
      storeId: z
        .string()
        .regex(/^\d+$/, "Instacart's store id, digits only")
        .optional()
        .describe("Instacart's id for the household's own store location, the sid in its checkout link (instacart.com/store/checkout_v4?sid=…), so Mise links straight to that store's cart"),
    })
    .optional(),
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
      planPriceUsd: z.number().positive().optional().describe("The plan's weekly price, in US dollars"),
      planCredits: z.number().positive().optional().describe('Credits the plan gives each week'),
      addOnCreditUsd: z.number().positive().optional().describe('What one credit over the plan costs, in US dollars'),
      boxServings: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Servings the box provides each week, as 4-serving recipes, such as 12 for three'),
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

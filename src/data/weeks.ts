import * as z from 'zod';
import { Weekday, type CalendarWeek } from '../core/calendar.ts';
import type { Recipe } from './recipes.ts';

export const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner'] as const;
export const MealSlot = z.enum(MEAL_SLOTS);
export type MealSlot = z.infer<typeof MealSlot>;

const Servings = z.number().int().nonnegative();

export const MealTargets = z.object({
  breakfast: Servings.optional(),
  lunch: Servings.optional(),
  dinner: Servings.optional(),
});

export type MealTargets = z.infer<typeof MealTargets>;

const PlannedMealSchema = z.object({
  recipeId: z.string(),
  title: z.string(),
  servings: z.number().positive(),
  day: Weekday.optional(),
  slot: MealSlot.optional(),
});

const HungryrootMealSchema = z.object({
  title: z.string().min(1),
  servings: z.number().positive(),
  day: Weekday.optional(),
  slot: MealSlot.optional(),
});

const orEmpty = <T>(items: T[] | null | undefined) => items ?? [];

const WeekDocSchema = z.object({
  meals: z.array(PlannedMealSchema).nullish().transform(orEmpty),
  hungryroot: z.array(HungryrootMealSchema).nullish().transform(orEmpty),
  targets: MealTargets.nullish().transform((targets) => targets ?? {}),
});

export type PlannedMeal = z.infer<typeof PlannedMealSchema>;
export type HungryrootMeal = z.infer<typeof HungryrootMealSchema>;

export interface MealRequest {
  recipeId: string;
  day?: Weekday;
  slot?: MealSlot;
}

export interface WeekDoc {
  id: string;
  data: unknown;
}

export interface WeekPlan {
  meals: PlannedMeal[];
  hungryroot?: HungryrootMeal[];
  targets?: MealTargets;
}

export interface Weeks {
  findWeekDocs: (householdId: string, weekIds: string[]) => Promise<WeekDoc[]>;
  savePlan: (householdId: string, weekId: string, plan: WeekPlan, plannedBy: string) => Promise<void>;
}

export interface PlannedWeek {
  week: CalendarWeek;
  meals: PlannedMeal[];
  hungryroot: HungryrootMeal[];
  targets: MealTargets;
}

export const loadWeeks = async (weeks: Weeks, householdId: string, wanted: CalendarWeek[]): Promise<PlannedWeek[]> => {
  const docs = await weeks.findWeekDocs(
    householdId,
    wanted.map((week) => week.id),
  );
  const byId = new Map(docs.map((doc) => [doc.id, WeekDocSchema.parse(doc.data)]));
  return wanted.map((week) => ({ week, ...(byId.get(week.id) ?? { meals: [], hungryroot: [], targets: {} }) }));
};

export const planMeals = (recipes: Recipe[], requests: MealRequest[]): PlannedMeal[] => {
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const meals: PlannedMeal[] = [];
  const unknown = new Set<string>();

  for (const { recipeId, day, slot } of requests) {
    const recipe = byId.get(recipeId);
    if (!recipe) {
      unknown.add(recipeId);
      continue;
    }
    meals.push({ recipeId, title: recipe.title, servings: recipe.servings, ...(day && { day }), ...(slot && { slot }) });
  }

  if (unknown.size > 0) {
    throw new Error(
      `These aren't recipes that can be planned: ${[...unknown].join(', ')}. Use ids from list_recipes; archived recipes and non-meals can't be planned.`,
    );
  }
  return meals;
};

export const lastPlannedDates = (planned: Pick<PlannedWeek, 'week' | 'meals'>[]): Map<string, string> => {
  const latest = new Map<string, string>();
  for (const { week, meals } of planned) {
    for (const { recipeId } of meals) {
      const seen = latest.get(recipeId);
      if (!seen || week.start > seen) latest.set(recipeId, week.start);
    }
  }
  return latest;
};

interface SlotCoverage {
  planned: number;
  fromHungryroot: number;
  fromLeftovers: number;
  target?: number;
  leftToPlan?: number;
  over?: number;
}

const servingsBySlot = ({ servings, slot = 'dinner' }: { servings: number; slot?: MealSlot }, people: number) => {
  if (slot !== 'dinner') return { [slot]: servings, leftovers: 0 };
  const eaten = Math.min(servings, people);
  return { dinner: eaten, lunch: servings - eaten, leftovers: servings - eaten };
};

export const weekCoverage = (
  { meals, hungryroot }: Pick<PlannedWeek, 'meals' | 'hungryroot'>,
  people: number,
  targets: MealTargets,
): Record<MealSlot, SlotCoverage> => {
  const coverage = Object.fromEntries(
    MEAL_SLOTS.map((slot) => [slot, { planned: 0, fromHungryroot: 0, fromLeftovers: 0 }]),
  ) as Record<MealSlot, SlotCoverage>;

  const count = (meal: { servings: number; slot?: MealSlot }, fromHungryroot: boolean) => {
    const { leftovers, ...bySlot } = servingsBySlot(meal, people);
    for (const [slot, servings] of Object.entries(bySlot) as [MealSlot, number][]) {
      coverage[slot].planned += servings;
      if (fromHungryroot) coverage[slot].fromHungryroot += servings;
    }
    coverage.lunch.fromLeftovers += leftovers;
  };
  for (const meal of meals) count(meal, false);
  for (const meal of hungryroot) count(meal, true);

  for (const slot of MEAL_SLOTS) {
    const target = targets[slot];
    if (target === undefined) continue;
    const { planned } = coverage[slot];
    coverage[slot] = {
      ...coverage[slot],
      target,
      ...(planned < target && { leftToPlan: target - planned }),
      ...(planned > target && { over: planned - target }),
    };
  }
  return coverage;
};

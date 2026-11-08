import * as z from 'zod';
import { Weekday, type CalendarWeek } from '../core/calendar.ts';
import type { Recipe } from './recipes.ts';

const PlannedMealSchema = z.object({
  recipeId: z.string(),
  title: z.string(),
  servings: z.number().positive(),
  day: Weekday.optional(),
});

const WeekDocSchema = z.object({
  meals: z
    .array(PlannedMealSchema)
    .nullish()
    .transform((meals) => meals ?? []),
});

export type PlannedMeal = z.infer<typeof PlannedMealSchema>;

export interface MealRequest {
  recipeId: string;
  servings?: number;
  day?: Weekday;
}

export interface WeekDoc {
  id: string;
  data: unknown;
}

export interface Weeks {
  findWeekDocs: (householdId: string, weekIds: string[]) => Promise<WeekDoc[]>;
  saveMeals: (householdId: string, weekId: string, meals: PlannedMeal[], plannedBy: string) => Promise<void>;
}

export interface PlannedWeek {
  week: CalendarWeek;
  meals: PlannedMeal[];
}

export const loadWeeks = async (weeks: Weeks, householdId: string, wanted: CalendarWeek[]): Promise<PlannedWeek[]> => {
  const docs = await weeks.findWeekDocs(
    householdId,
    wanted.map((week) => week.id),
  );
  const mealsById = new Map(docs.map((doc) => [doc.id, WeekDocSchema.parse(doc.data).meals]));
  return wanted.map((week) => ({ week, meals: mealsById.get(week.id) ?? [] }));
};

export const planMeals = (recipes: Recipe[], requests: MealRequest[]): PlannedMeal[] => {
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const meals: PlannedMeal[] = [];
  const unknown = new Set<string>();

  for (const { recipeId, servings, day } of requests) {
    const recipe = byId.get(recipeId);
    if (!recipe) {
      unknown.add(recipeId);
      continue;
    }
    meals.push({ recipeId, title: recipe.title, servings: servings ?? recipe.servings, ...(day && { day }) });
  }

  if (unknown.size > 0) {
    throw new Error(
      `These aren't recipes that can be planned: ${[...unknown].join(', ')}. Use ids from list_recipes; archived recipes and non-meals can't be planned.`,
    );
  }
  return meals;
};

export const lastPlannedDates = (planned: PlannedWeek[]): Map<string, string> => {
  const latest = new Map<string, string>();
  for (const { week, meals } of planned) {
    for (const { recipeId } of meals) {
      const seen = latest.get(recipeId);
      if (!seen || week.start > seen) latest.set(recipeId, week.start);
    }
  }
  return latest;
};

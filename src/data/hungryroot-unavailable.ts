export interface UnavailableRecipe {
  id: string;
  title: string;
  hungryrootId: number;
  firstMarkedAt: string;
  lastMarkedAt: string;
  times: number;
  lastMarkedBy: string;
  lastWeek: string;
}

export interface MarkUnavailable {
  id: string;
  title: string;
  hungryrootId: number;
  week: string;
  by: string;
  at: string;
}

export interface HungryrootUnavailable {
  list: (householdId: string) => Promise<UnavailableRecipe[]>;
  mark: (householdId: string, mark: MarkUnavailable) => Promise<UnavailableRecipe>;
  clear: (householdId: string, ids: string[]) => Promise<void>;
}

export const markedAgain = (existing: UnavailableRecipe | undefined, { id, title, hungryrootId, week, by, at }: MarkUnavailable): UnavailableRecipe => ({
  id,
  title,
  hungryrootId,
  firstMarkedAt: existing?.firstMarkedAt ?? at,
  lastMarkedAt: at,
  times: (existing?.times ?? 0) + 1,
  lastMarkedBy: by,
  lastWeek: week,
});

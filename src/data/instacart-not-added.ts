export interface NotAdded {
  productId: string;
  name: string | null;
  times: number;
  firstAt: string;
  lastAt: string;
  lastWeek: string;
  said: string | null;
}

export interface Missed {
  productId: string;
  name: string | null;
  said: string | null;
}

export interface FillOutcome {
  week: string;
  at: string;
  missed: Missed[];
  landed: string[];
}

export interface InstacartNotAdded {
  list: (householdId: string) => Promise<NotAdded[]>;
  record: (householdId: string, outcome: FillOutcome) => Promise<void>;
}

export const missedAgain = (existing: NotAdded | undefined, { productId, name, said }: Missed, week: string, at: string): NotAdded => ({
  productId,
  name: name ?? existing?.name ?? null,
  times: (existing?.times ?? 0) + 1,
  firstAt: existing?.firstAt ?? at,
  lastAt: at,
  lastWeek: week,
  said: said ?? existing?.said ?? null,
});

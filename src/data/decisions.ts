export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Decision {
  kind: 'parse-correction' | 'ingredient-rename' | 'ingredient-buying' | 'alias-removal' | 'note-write' | 'note-delete' | 'food-match' | 'food-search' | 'unit-weight' | 'product-choice' | 'store-search' | 'store-preference' | 'vegan-review';
  input: Json;
  suggestion: Json;
  answer: Json;
  by: string;
}

export interface Decisions {
  record: (householdId: string, decision: Decision) => Promise<void>;
}

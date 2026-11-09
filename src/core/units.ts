import type { Unit } from '../llm/parse-ingredients.ts';

export const GRAMS_PER: Partial<Record<Unit, number>> = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };

export const ML_PER: Partial<Record<Unit, number>> = {
  ml: 1,
  l: 1000,
  tsp: 4.92892,
  tbsp: 14.7868,
  cup: 236.588,
  'fl oz': 29.5735,
  pinch: 0.31,
  dash: 0.62,
};

export const COUNT_UNITS = [
  'clove',
  'piece',
  'slice',
  'block',
  'can',
  'jar',
  'package',
  'bag',
  'bottle',
  'bunch',
  'head',
  'sprig',
  'stalk',
  'sheet',
  'patty',
] as const satisfies readonly Unit[];

export type CountUnit = (typeof COUNT_UNITS)[number];

export const isCountUnit = (unit: string): unit is CountUnit => (COUNT_UNITS as readonly string[]).includes(unit);

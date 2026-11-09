import type { IngredientEntry } from '../data/ingredients.ts';
import type { Unit } from '../llm/parse-ingredients.ts';
import { GRAMS_PER, isCountUnit, ML_PER } from './units.ts';

export interface Need {
  value: number;
  unit: Unit;
  eachGrams?: number;
}

type Size = { kind: 'count'; count: number } | { kind: 'grams'; grams: number } | { kind: 'ml'; ml: number };

const SIZE_UNITS: Record<string, { grams?: number; ml?: number; count?: true }> = {
  oz: { grams: 28.3495 },
  onz: { grams: 28.3495 },
  lb: { grams: 453.592 },
  lbs: { grams: 453.592 },
  g: { grams: 1 },
  kg: { grams: 1000 },
  'fl oz': { ml: 29.5735 },
  ml: { ml: 1 },
  l: { ml: 1000 },
  qt: { ml: 946.353 },
  pt: { ml: 473.176 },
  gal: { ml: 3785.41 },
  ct: { count: true },
  each: { count: true },
  count: { count: true },
  pk: { count: true },
};

const amountOf = (text: string) => {
  const [whole, fraction] = text.includes('/') ? text.split('/') : [text, undefined];
  return fraction === undefined ? Number(whole) : Number(whole) / Number(fraction);
};

const sizePart = (text: string): Size | null => {
  const match = /^\s*([\d.]+(?:\/[\d.]+)?)\s*(fl oz|[a-z]+)\b/i.exec(text);
  if (!match?.[1] || !match[2]) return null;
  const amount = amountOf(match[1]);
  const unit = SIZE_UNITS[match[2].toLowerCase()];
  if (!unit || !Number.isFinite(amount) || amount <= 0) return null;
  if (unit.count) return { kind: 'count', count: amount };
  return unit.grams ? { kind: 'grams', grams: amount * unit.grams } : { kind: 'ml', ml: amount * (unit.ml ?? 0) };
};

export const parseSize = (text: string | null): Size | null => {
  if (!text) return null;
  const parts = text.split(/\s+\/\s+/);
  const sizes = parts.map(sizePart).filter((size): size is Size => size !== null);
  const count = sizes.find((size) => size.kind === 'count');
  const measured = sizes.find((size) => size.kind !== 'count');
  if (count && measured && count.kind === 'count') {
    return measured.kind === 'grams'
      ? { kind: 'grams', grams: measured.grams * count.count }
      : { kind: 'ml', ml: measured.kind === 'ml' ? measured.ml * count.count : 0 };
  }
  return sizes[0] ?? null;
};

type Weights = Pick<IngredientEntry, 'gramsPerMl' | 'unitWeights'>;

const needGrams = ({ value, unit, eachGrams }: Need, { gramsPerMl, unitWeights }: Weights) => {
  const perGram = GRAMS_PER[unit];
  if (perGram) return value * perGram;
  const perMl = ML_PER[unit];
  if (perMl) return gramsPerMl ? value * perMl * gramsPerMl : null;
  const each = eachGrams ?? (isCountUnit(unit) ? unitWeights[unit] : undefined);
  return each ? value * each : null;
};

const sizeGrams = (size: Size, { gramsPerMl }: Weights) => {
  if (size.kind === 'grams') return size.grams;
  if (size.kind === 'ml') return gramsPerMl ? size.ml * gramsPerMl : null;
  return null;
};

const COUNTED_LIKE_ITEMS = new Set<Unit>(['piece', 'head', 'bunch', 'block', 'can', 'jar', 'package', 'bag', 'bottle', 'patty']);
const CONTAINERS = new Set<Unit>(['block', 'can', 'jar', 'package', 'bag', 'bottle']);

export const packagesCovering = (need: Need, covers: number) => Math.max(1, Math.ceil(need.value / covers - 1e-9));

export const packagesFor = (need: Need, sizeText: string | null, weights: Weights): number | null => {
  const size = parseSize(sizeText);
  if (!size) return null;
  if (size.kind === 'count') return COUNTED_LIKE_ITEMS.has(need.unit) ? packagesCovering(need, size.count) : null;
  if (size.kind === 'ml' && ML_PER[need.unit]) return Math.max(1, Math.ceil((need.value * (ML_PER[need.unit] ?? 0)) / size.ml - 1e-9));
  const wanted = needGrams(need, weights);
  const packaged = sizeGrams(size, weights);
  if (wanted && packaged) return Math.max(1, Math.ceil(wanted / packaged - 1e-9));
  return CONTAINERS.has(need.unit) ? packagesCovering(need, 1) : null;
};

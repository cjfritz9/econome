import { createHash } from 'node:crypto';
import type { Ingredient, Recipe } from '../data/recipes.ts';

export interface KeyedLine {
  key: string;
  line: Ingredient;
}

const UNIT_SPELLINGS: Record<string, string> = {
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  tsps: 'tsp',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  tbsps: 'tbsp',
  tbs: 'tbsp',
  tbl: 'tbsp',
  cups: 'cup',
  ounce: 'oz',
  ounces: 'oz',
  pound: 'lb',
  pounds: 'lb',
  lbs: 'lb',
  gram: 'g',
  grams: 'g',
  kilogram: 'kg',
  kilograms: 'kg',
  milliliter: 'ml',
  milliliters: 'ml',
  liter: 'l',
  liters: 'l',
  cloves: 'clove',
  pieces: 'piece',
  slices: 'slice',
  blocks: 'block',
  cans: 'can',
  jars: 'jar',
  packages: 'package',
  pkg: 'package',
  pkgs: 'package',
  bags: 'bag',
  bottles: 'bottle',
  bunches: 'bunch',
  heads: 'head',
  sprigs: 'sprig',
  stalks: 'stalk',
  sheets: 'sheet',
  patties: 'patty',
  pinches: 'pinch',
  dashes: 'dash',
};

export const normalizeText = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '')
    .trim();

const normalizeUnit = (unit: string) => {
  const text = normalizeText(unit);
  return UNIT_SPELLINGS[text] ?? text;
};

export const lineKey = ({ amount, unit, name }: Ingredient) =>
  createHash('sha256').update(`${amount}|${normalizeUnit(unit)}|${normalizeText(name)}`).digest('hex').slice(0, 32);

export const formatLine = ({ amount, unit, name }: Ingredient) => `${amount} ${unit.trim()} | ${name.trim()}`;

export const uniqueLines = (recipe: Recipe): KeyedLine[] => {
  const lines = new Map<string, Ingredient>();
  for (const group of recipe.ingredientGroups) {
    for (const line of group.ingredients) lines.set(lineKey(line), line);
  }
  return [...lines].map(([key, line]) => ({ key, line }));
};

export const recipesWithLine = (recipes: Recipe[], line: Ingredient) => {
  const key = lineKey(line);
  return recipes.filter((recipe) => uniqueLines(recipe).some((keyed) => keyed.key === key)).map(({ id }) => id);
};

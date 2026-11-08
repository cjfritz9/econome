import { createHash } from 'node:crypto';
import type { Ingredient, Recipe } from '../data/recipes.ts';

export interface KeyedLine {
  key: string;
  line: Ingredient;
}

export const lineKey = ({ amount, unit, name }: Ingredient) =>
  createHash('sha256').update(`${amount}|${unit.trim()}|${name.trim()}`).digest('hex').slice(0, 32);

export const formatLine = ({ amount, unit, name }: Ingredient) => `${amount} ${unit.trim()} | ${name.trim()}`;

export const uniqueLines = (recipe: Recipe): KeyedLine[] => {
  const lines = new Map<string, Ingredient>();
  for (const group of recipe.ingredientGroups) {
    for (const line of group.ingredients) lines.set(lineKey(line), line);
  }
  return [...lines].map(([key, line]) => ({ key, line }));
};

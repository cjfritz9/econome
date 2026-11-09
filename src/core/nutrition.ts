import type { IngredientEntry } from '../data/ingredients.ts';
import type { ParsedLine } from '../data/parsed-lines.ts';
import type { Recipe } from '../data/recipes.ts';
import type { LineParse } from '../llm/parse-ingredients.ts';
import type { Nutrient } from '../sources/fdc.ts';
import { formatLine, lineKey } from './ingredient-lines.ts';
import { GRAMS_PER, isCountUnit, ML_PER } from './units.ts';

export type Nutrients = Record<Nutrient, number>;

type Weights = Pick<IngredientEntry, 'gramsPerMl' | 'unitWeights'>;

const NUTRIENTS: Nutrient[] = ['kcal', 'protein', 'carbs', 'sugar', 'fiber', 'fat'];

const volumeGrams = (ml: number, { gramsPerMl }: Weights) => (gramsPerMl ? ml * gramsPerMl : null);

const packageGrams = ({ packageSize }: LineParse, weights: Weights) => {
  if (!packageSize) return null;
  const perGram = GRAMS_PER[packageSize.unit];
  if (perGram) return packageSize.amount * perGram;
  const perMl = ML_PER[packageSize.unit];
  return perMl ? volumeGrams(packageSize.amount * perMl, weights) : null;
};

export const lineGrams = (parse: LineParse, weights: Weights): number | null => {
  const { amount, unit } = parse;
  const perGram = GRAMS_PER[unit];
  if (perGram) return amount * perGram;
  const perMl = ML_PER[unit];
  if (perMl) return volumeGrams(amount * perMl, weights);
  const perPackage = packageGrams(parse, weights);
  if (perPackage) return amount * perPackage;
  const each = isCountUnit(unit) ? weights.unitWeights[unit] : undefined;
  return each ? amount * each : null;
};

const gapReason = (parsed: ParsedLine | undefined, entry: IngredientEntry | undefined) => {
  if (!parsed) return 'not parsed yet';
  if (parsed.parse.measuredAs) return `measured ${parsed.parse.measuredAs}`;
  if (!entry?.food) return 'no food matched yet';
  if (entry.food.fdcId === null || !entry.food.per100g) return 'no FoodData Central food';
  return lineGrams(parsed.parse, entry) === null ? `no weight for ${parsed.parse.unit}` : null;
};

const round = (value: number, places: number) => Number(value.toFixed(places));

export const recipeNutrition = (recipe: Recipe, lines: Map<string, ParsedLine>, entries: Map<string, IngredientEntry>) => {
  const totals: Nutrients = { kcal: 0, protein: 0, carbs: 0, sugar: 0, fiber: 0, fat: 0 };
  const gaps: string[] = [];
  const unknown = new Map<string, Set<Nutrient>>();
  let counted = 0;

  for (const line of recipe.ingredientGroups.flatMap(({ ingredients }) => ingredients)) {
    const parsed = lines.get(lineKey(line));
    if (parsed?.parse.toTaste) {
      gaps.push(`${formatLine(line)} (to taste)`);
      continue;
    }
    const entry = parsed && entries.get(parsed.parse.ingredient);
    const reason = gapReason(parsed, entry);
    if (reason || !parsed || !entry?.food?.per100g) {
      gaps.push(`${formatLine(line)} (${reason})`);
      continue;
    }
    const grams = lineGrams(parsed.parse, entry) ?? 0;
    for (const nutrient of NUTRIENTS) {
      const per100g = entry.food.per100g[nutrient];
      if (per100g === null) unknown.set(entry.name, (unknown.get(entry.name) ?? new Set()).add(nutrient));
      totals[nutrient] += (grams / 100) * (per100g ?? 0);
    }
    counted += 1;
  }

  const missing = [...unknown].map(([name, nutrients]) => `${name}: ${[...nutrients].join(', ')}`);
  if (counted === 0) return { perServing: null, gaps, missing };
  const serving = (nutrient: Nutrient, places = 1) => round(totals[nutrient] / recipe.servings, places);
  const perServing: Nutrients = {
    kcal: serving('kcal', 0),
    protein: serving('protein'),
    carbs: serving('carbs'),
    sugar: serving('sugar'),
    fiber: serving('fiber'),
    fat: serving('fat'),
  };
  return { perServing, gaps, missing };
};

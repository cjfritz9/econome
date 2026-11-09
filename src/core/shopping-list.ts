import type { IngredientEntry } from '../data/ingredients.ts';
import type { ParsedLine } from '../data/parsed-lines.ts';
import type { Recipe } from '../data/recipes.ts';
import type { PlannedMeal } from '../data/weeks.ts';
import type { LineParse, Unit } from '../llm/parse-ingredients.ts';
import { formatLine, lineKey } from './ingredient-lines.ts';
import { lineGrams } from './nutrition.ts';
import { GRAMS_PER, isCountUnit, ML_PER } from './units.ts';

interface Use {
  recipe: string;
  line: string;
  parse: LineParse | null;
}

export interface ListItem {
  ingredient: string;
  need: string | null;
  buy?: string;
  comesWith?: string;
  alternatives?: string[];
  optional?: true;
  runningLow?: true;
  uses: string[];
}

export interface ShoppingList {
  buy: ListItem[];
  probablyHave: ListItem[];
  have: ListItem[];
  decide: ListItem[];
  notBought: ListItem[];
  warnings: string[];
}

type Weights = Pick<IngredientEntry, 'gramsPerMl' | 'unitWeights'>;

const NO_WEIGHTS: Weights = { gramsPerMl: null, unitWeights: {} };

const n = (value: number) => String(Number(value.toFixed(2)));

const amountOf = ({ amount, unit, packageSize }: LineParse) =>
  `${n(amount)} ${unit}${packageSize ? ` (${n(packageSize.amount)} ${packageSize.unit} each)` : ''}`;

const describeUse = ({ recipe, line, parse }: Use) => {
  if (!parse) return `${recipe}: as needed, from "${line}"`;
  if (parse.toTaste) return `${recipe}: to taste`;
  const measured = parse.measuredAs ? ` ${parse.measuredAs}` : '';
  return `${recipe}: ${amountOf(parse)}${measured}${parse.optional ? ' (optional)' : ''}`;
};

const counts = (parse: LineParse | null): parse is LineParse =>
  parse !== null && !parse.toTaste && !parse.measuredAs && parse.amount > 0;

const family = (unit: Unit) => (GRAMS_PER[unit] ? 'weight' : ML_PER[unit] ? 'volume' : unit);

const largestUnit = (units: Unit[], per: Partial<Record<Unit, number>>) =>
  units.reduce((best, unit) => ((per[unit] ?? 0) > (per[best] ?? 0) ? unit : best));

const sumSameFamily = (parses: LineParse[]): { amount: number; unit: Unit } => {
  const units = parses.map(({ unit }) => unit);
  for (const per of [GRAMS_PER, ML_PER]) {
    if (!units.every((unit) => per[unit])) continue;
    const unit = largestUnit(units, per);
    const base = parses.reduce((sum, parse) => sum + parse.amount * (per[parse.unit] ?? 0), 0);
    return { amount: base / (per[unit] ?? 1), unit };
  }
  return { amount: parses.reduce((sum, { amount }) => sum + amount, 0), unit: parses[0]?.unit ?? 'piece' };
};

const gramsPerUnit = (unit: Unit, parses: LineParse[], weights: Weights) => {
  const sample = parses.find((parse) => parse.unit === unit && parse.packageSize) ?? parses.find((parse) => parse.unit === unit);
  return sample ? lineGrams({ ...sample, amount: 1 }, weights) : null;
};

const toBuy = (amount: number, unit: Unit) =>
  isCountUnit(unit) && !Number.isInteger(Number(amount.toFixed(2))) ? `${Math.ceil(amount)} ${unit}` : undefined;

type Total = { need: string; buy?: string } | { parts: string[]; unweighed: Unit[] };

export const totalNeed = (parses: LineParse[], weights: Weights): Total | null => {
  if (parses.length === 0) return null;
  const families = new Map<string, LineParse[]>();
  for (const parse of parses) families.set(family(parse.unit), [...(families.get(family(parse.unit)) ?? []), parse]);
  if (families.size === 1) {
    const { amount, unit } = sumSameFamily(parses);
    const buy = toBuy(amount, unit);
    return { need: `${n(amount)} ${unit}`, ...(buy && { buy }) };
  }

  const unweighed = [...new Set(parses.filter((parse) => lineGrams(parse, weights) === null).map(({ unit }) => unit))];
  if (unweighed.length > 0) {
    const parts = [...families.values()].map((group) => {
      const { amount, unit } = sumSameFamily(group);
      return `${n(amount)} ${unit}`;
    });
    return { parts, unweighed };
  }

  const grams = parses.reduce((sum, parse) => sum + (lineGrams(parse, weights) ?? 0), 0);
  const units = parses.map(({ unit }) => unit);
  const countUnit = units.find((unit) => isCountUnit(unit) && gramsPerUnit(unit, parses, weights));
  const unit = countUnit ?? (units.some((each) => GRAMS_PER[each]) ? largestUnit(units, GRAMS_PER) : 'g');
  const amount = grams / (gramsPerUnit(unit, parses, weights) ?? 1);
  const buy = toBuy(amount, unit);
  return { need: `≈ ${n(amount)} ${unit}`, ...(buy && { buy }) };
};

const collectUses = (meals: PlannedMeal[], recipes: Recipe[], lines: Map<string, ParsedLine>, warnings: string[]) => {
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const uses = new Map<string, Use[]>();
  const add = (name: string, use: Use) => uses.set(name, [...(uses.get(name) ?? []), use]);

  for (const meal of meals) {
    const recipe = byId.get(meal.recipeId);
    if (!recipe) {
      warnings.push(`${meal.title} can't be planned any more (archived, or tagged not-a-meal), so it adds nothing to the list.`);
      continue;
    }
    for (const line of recipe.ingredientGroups.flatMap(({ ingredients }) => ingredients)) {
      const text = formatLine(line);
      const parsed = lines.get(lineKey(line));
      if (!parsed) {
        warnings.push(`${recipe.title}: "${text}" isn't parsed yet, so it's not on the list.`);
        continue;
      }
      add(parsed.parse.ingredient, { recipe: recipe.title, line: text, parse: parsed.parse });
      for (const also of parsed.parse.alsoNeeded) add(also, { recipe: recipe.title, line: text, parse: null });
    }
  }
  return uses;
};

const byName = (a: ListItem, b: ListItem) => a.ingredient.localeCompare(b.ingredient);

export const buildList = (
  meals: PlannedMeal[],
  recipes: Recipe[],
  lines: Map<string, ParsedLine>,
  entries: IngredientEntry[],
  have: Record<string, boolean> = {},
): ShoppingList => {
  const warnings: string[] = [];
  const registry = new Map(entries.map((entry) => [entry.name, entry]));
  const list: ShoppingList = { buy: [], probablyHave: [], have: [], decide: [], notBought: [], warnings };

  for (const [ingredient, uses] of collectUses(meals, recipes, lines, warnings)) {
    const entry = registry.get(ingredient);
    const parses = uses.map(({ parse }) => parse);
    const total = totalNeed(parses.filter(counts), entry ?? NO_WEIGHTS);
    const alternatives = [...new Set(parses.flatMap((parse) => parse?.alternatives ?? []))];

    for (const { recipe, parse } of uses) {
      if (parse?.measuredAs) warnings.push(`${recipe}: ${ingredient} is measured ${parse.measuredAs}, so it's not counted in how much to buy.`);
    }
    if (total && 'parts' in total) {
      warnings.push(
        `${ingredient}: ${total.parts.join(' and ')} can't be added together without a weight for ${total.unweighed.join(', ')}; set one with set_unit_weight.`,
      );
    }

    const item: ListItem = {
      ingredient,
      need: total ? ('need' in total ? total.need : total.parts.join(' + ')) : null,
      ...(total && 'buy' in total && total.buy && { buy: total.buy }),
      ...(entry?.comesWith && { comesWith: entry.comesWith }),
      ...(alternatives.length > 0 && { alternatives }),
      ...(parses.every((parse) => parse?.optional) && { optional: true as const }),
      uses: uses.map(describeUse),
    };
    const buying = entry?.buying;
    const answer = have[ingredient];
    if (buying === 'never') list.notBought.push(item);
    else if (answer === true) list.have.push(item);
    else if (buying === 'staple' && answer === false) list.buy.push({ ...item, runningLow: true });
    else if (buying === 'staple') list.probablyHave.push(item);
    else if (buying === 'weekly') list.buy.push(item);
    else list.decide.push(item);
  }

  for (const section of [list.buy, list.probablyHave, list.have, list.decide, list.notBought]) section.sort(byName);
  return list;
};

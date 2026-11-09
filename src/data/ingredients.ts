import * as z from 'zod';
import { COUNT_UNITS, GRAMS_PER, isCountUnit, ML_PER, type CountUnit } from '../core/units.ts';
import type { LineParse, Unit } from '../llm/parse-ingredients.ts';

export const BUYING = ['weekly', 'staple', 'never'] as const;

const Per100gSchema = z.object({
  kcal: z.number().nullable(),
  protein: z.number().nullable(),
  carbs: z.number().nullable(),
  sugar: z.number().nullable(),
  fiber: z.number().nullable(),
  fat: z.number().nullable(),
});

export const FoodMatchSchema = z.object({
  fdcId: z.number().int().nullable(),
  description: z.string().nullable(),
  per100g: Per100gSchema.nullable(),
  source: z.enum(['claude', 'corrected']),
  doubt: z.string().nullable(),
});

export type FoodMatch = z.infer<typeof FoodMatchSchema>;

export const IngredientEntrySchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()),
  buying: z.enum(BUYING).nullable(),
  comesWith: z.string().nullable(),
  food: FoodMatchSchema.nullable().default(null),
  fdcQuery: z.string().nullable().default(null),
  gramsPerMl: z.number().positive().nullable().default(null),
  unitWeights: z.partialRecord(z.enum(COUNT_UNITS), z.number().positive()).default({}),
});

export type IngredientEntry = z.infer<typeof IngredientEntrySchema> & { id: string };
export type Buying = (typeof BUYING)[number];

export interface IngredientRegistry {
  list: (householdId: string) => Promise<IngredientEntry[]>;
  save: (householdId: string, entries: IngredientEntry[]) => Promise<void>;
  remove: (householdId: string, ids: string[]) => Promise<void>;
}

export const normalizeName = (name: string) => name.trim().toLowerCase();

const ingredientId = (name: string) =>
  normalizeName(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const newEntry = (name: string): IngredientEntry => ({
  id: ingredientId(name),
  name,
  aliases: [],
  buying: null,
  comesWith: null,
  food: null,
  fdcQuery: null,
  gramsPerMl: null,
  unitWeights: {},
});

const entryFor = (entries: IngredientEntry[], name: string) => entries.find((entry) => entry.name === name) ?? newEntry(name);

export const withFood = (
  entries: IngredientEntry[],
  name: string,
  food: FoodMatch,
  weights: { gramsPerMl: number | null; unitWeights: Partial<Record<CountUnit, number>> } = { gramsPerMl: null, unitWeights: {} },
): IngredientEntry => {
  const entry = entryFor(entries, name);
  return {
    ...entry,
    food,
    gramsPerMl: entry.gramsPerMl ?? weights.gramsPerMl,
    unitWeights: { ...weights.unitWeights, ...entry.unitWeights },
  };
};

export const withFdcQuery = (entries: IngredientEntry[], name: string, query: string): IngredientEntry => ({
  ...entryFor(entries, name),
  fdcQuery: query.trim(),
});

export const withUnitWeight = (entries: IngredientEntry[], name: string, unit: Unit, grams: number): IngredientEntry => {
  const entry = entryFor(entries, name);
  const ml = ML_PER[unit];
  if (ml) return { ...entry, gramsPerMl: grams / ml };
  if (isCountUnit(unit)) return { ...entry, unitWeights: { ...entry.unitWeights, [unit]: grams } };
  if (GRAMS_PER[unit]) throw new Error(`"${unit}" is already a weight, so it needs no conversion.`);
  throw new Error(`Économe can't weigh the unit "${unit}".`);
};

export const describeWeights = ({ gramsPerMl, unitWeights }: Pick<IngredientEntry, 'gramsPerMl' | 'unitWeights'>) => [
  ...(gramsPerMl ? [`1 cup = ${Math.round(gramsPerMl * (ML_PER.cup ?? 0))} g`] : []),
  ...Object.entries(unitWeights).map(([unit, grams]) => `1 ${unit} = ${Math.round(grams)} g`),
];

const unique = (names: string[]) => [...new Set(names)];

export const aliasMap = (entries: IngredientEntry[]) =>
  new Map(entries.flatMap(({ name, aliases }) => aliases.map((alias) => [alias, name] as const)));

export const withAliases = (parse: LineParse, aliases: Map<string, string>): LineParse => {
  const canonical = (name: string) => aliases.get(normalizeName(name)) ?? name;
  const ingredient = canonical(parse.ingredient);
  const others = (names: string[]) => unique(names.map(canonical)).filter((name) => name !== ingredient);
  return {
    ...parse,
    ingredient,
    alternatives: others(parse.alternatives),
    alsoNeeded: others(parse.alsoNeeded),
  };
};

export const addAlias = (entries: IngredientEntry[], from: string, to: string) => {
  const alias = normalizeName(from);
  if (alias === normalizeName(to)) throw new Error(`"${from}" and "${to}" are the same name.`);

  const source = entries.find(({ name }) => normalizeName(name) === alias);
  const target = entries.find(({ name }) => name === to) ?? newEntry(to);
  const merged: IngredientEntry = {
    ...target,
    aliases: unique([...target.aliases, alias, ...(source?.aliases ?? [])]),
    buying: target.buying ?? source?.buying ?? null,
    comesWith: target.comesWith ?? source?.comesWith ?? null,
  };

  const others = entries
    .filter(({ id }) => id !== target.id && id !== source?.id)
    .filter(({ aliases, comesWith }) => aliases.includes(alias) || (source && comesWith === source.name))
    .map((entry) => ({
      ...entry,
      aliases: entry.aliases.filter((name) => name !== alias),
      comesWith: source && entry.comesWith === source.name ? to : entry.comesWith,
    }));

  return { saved: [merged, ...others], removedIds: source && source.id !== target.id ? [source.id] : [] };
};

export const removeAlias = (entries: IngredientEntry[], alias: string): IngredientEntry => {
  const name = normalizeName(alias);
  const owner = entries.find(({ aliases }) => aliases.includes(name));
  if (!owner) throw new Error(`No ingredient has the alias "${alias}".`);
  return { ...owner, aliases: owner.aliases.filter((existing) => existing !== name) };
};

export const setBuying = (
  entries: IngredientEntry[],
  names: string[],
  buying: Buying,
  comesWith: string | null,
): IngredientEntry[] =>
  unique(names).map((name) => ({
    ...entryFor(entries, name),
    buying,
    comesWith: buying === 'never' ? comesWith : null,
  }));

export const describeIngredients = (index: { ingredient: string; lines: string[] }[], entries: IngredientEntry[]) => {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const names = unique([...index.map(({ ingredient }) => ingredient), ...byName.keys()]).sort((a, b) => a.localeCompare(b));
  const linesOf = new Map(index.map(({ ingredient, lines }) => [ingredient, lines]));
  return names.map((ingredient) => {
    const entry = byName.get(ingredient);
    const weights = entry ? describeWeights(entry) : [];
    return {
      ingredient,
      buying: entry?.buying ?? 'undecided',
      ...(entry?.comesWith && { comesWith: entry.comesWith }),
      ...(entry && entry.aliases.length > 0 && { aliases: entry.aliases }),
      ...(entry?.food && { food: entry.food.description ?? 'no FDC food' }),
      ...(entry?.fdcQuery && { searchAs: entry.fdcQuery }),
      ...(weights.length > 0 && { weights }),
      lines: linesOf.get(ingredient) ?? [],
    };
  });
};

import * as z from 'zod';

const FDC_BASE = 'https://api.nal.usda.gov/fdc/v1';
const GENERIC = ['Foundation', 'SR Legacy', 'Survey (FNDDS)'];
const GENERIC_RESULTS = 6;
const BRANDED_RESULTS = 3;
const PORTIONS_SHOWN = 6;

const NUTRIENT_NUMBERS = {
  kcal: ['208', '957', '958'],
  protein: ['203'],
  carbs: ['205', '205.2'],
  sugar: ['269', '269.3'],
  fiber: ['291'],
  fat: ['204', '298'],
} as const;

export type Nutrient = keyof typeof NUTRIENT_NUMBERS;
export type Per100g = Record<Nutrient, number | null>;

export interface FdcFood {
  fdcId: number;
  description: string;
  dataType: string;
  per100g: Per100g;
  portions: string[];
}

export interface FoodData {
  candidates: (query: string) => Promise<FdcFood[]>;
  food: (fdcId: number) => Promise<FdcFood | null>;
}

const SearchSchema = z.object({ foods: z.array(z.object({ fdcId: z.number() })) });

const PortionSchema = z.object({
  amount: z.number().nullish(),
  gramWeight: z.number().nullish(),
  modifier: z.string().nullish(),
  portionDescription: z.string().nullish(),
  measureUnit: z.object({ name: z.string() }).nullish(),
});

const FoodSchema = z.object({
  fdcId: z.number(),
  description: z.string(),
  dataType: z.string(),
  brandOwner: z.string().nullish(),
  brandName: z.string().nullish(),
  servingSize: z.number().nullish(),
  servingSizeUnit: z.string().nullish(),
  householdServingFullText: z.string().nullish(),
  foodNutrients: z
    .array(z.object({ nutrient: z.object({ number: z.string() }).nullish(), amount: z.number().nullish() }))
    .default([]),
  foodPortions: z.array(PortionSchema).default([]),
});

type FoodJson = z.infer<typeof FoodSchema>;

export const searchTerm = (query: string) => query.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();

const grams = (weight: number) => `${Number(weight.toFixed(1))} g`;

const describePortion = ({ amount, gramWeight, modifier, portionDescription, measureUnit }: z.infer<typeof PortionSchema>) => {
  if (!gramWeight) return null;
  if (portionDescription && portionDescription !== 'Quantity not specified') return `${portionDescription} = ${grams(gramWeight)}`;
  const unit = measureUnit?.name;
  if (unit === 'RACC') return null;
  const words = [unit && unit !== 'undetermined' ? unit : null, modifier && !/^\d+$/.test(modifier) ? modifier : null]
    .filter(Boolean)
    .join(' ');
  return words ? `${amount ?? 1} ${words} = ${grams(gramWeight)}` : null;
};

const brandedServing = ({ servingSize, servingSizeUnit, householdServingFullText }: FoodJson) =>
  servingSize && householdServingFullText && /^(g|grm)$/i.test(servingSizeUnit ?? '')
    ? [`${householdServingFullText} = ${grams(servingSize)}`]
    : [];

export const toFood = (json: FoodJson): FdcFood => {
  const amounts = new Map(json.foodNutrients.flatMap(({ nutrient, amount }) => (nutrient && amount != null ? [[nutrient.number, amount]] : [])));
  const nutrient = (numbers: readonly string[]) => numbers.map((number) => amounts.get(number)).find((value) => value !== undefined) ?? null;
  const brand = json.brandName ?? json.brandOwner;
  const portions = [...json.foodPortions.map(describePortion), ...brandedServing(json)].filter((portion): portion is string => portion !== null);
  return {
    fdcId: json.fdcId,
    description: brand ? `${json.description} (${brand})` : json.description,
    dataType: json.dataType,
    per100g: {
      kcal: nutrient(NUTRIENT_NUMBERS.kcal),
      protein: nutrient(NUTRIENT_NUMBERS.protein),
      carbs: nutrient(NUTRIENT_NUMBERS.carbs),
      sugar: nutrient(NUTRIENT_NUMBERS.sugar),
      fiber: nutrient(NUTRIENT_NUMBERS.fiber),
      fat: nutrient(NUTRIENT_NUMBERS.fat),
    },
    portions: [...new Set(portions)].slice(0, PORTIONS_SHOWN),
  };
};

export const fdcClient = (apiKey: string, fetchJson: typeof fetch = fetch): FoodData => {
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetchJson(`${FDC_BASE}${path}?api_key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Econome (household grocery planner)' },
      body: JSON.stringify(body),
    });
    if (response.status === 429) throw new Error("FoodData Central's hourly request limit is used up. Try again in an hour.");
    if (!response.ok) throw new Error(`FoodData Central answered ${response.status}.`);
    return response.json();
  };

  const search = async (query: string, dataType: string[], pageSize: number) =>
    SearchSchema.parse(await post('/foods/search', { query: searchTerm(query), dataType, pageSize })).foods.map(({ fdcId }) => fdcId);

  const details = async (fdcIds: number[]) => {
    if (fdcIds.length === 0) return [];
    const nutrients = Object.values(NUTRIENT_NUMBERS).flat().map(Number);
    return z.array(FoodSchema).parse(await post('/foods', { fdcIds, format: 'full', nutrients })).map(toFood);
  };

  return {
    candidates: async (query) => {
      const [generic, branded] = await Promise.all([
        search(query, GENERIC, GENERIC_RESULTS),
        search(query, ['Branded'], BRANDED_RESULTS),
      ]);
      const ids = [...new Set([...generic, ...branded])];
      const byId = new Map((await details(ids)).map((food) => [food.fdcId, food]));
      return ids.flatMap((id) => byId.get(id) ?? []);
    },
    food: async (fdcId) => (await details([fdcId]))[0] ?? null,
  };
};

import { lineKey } from '../src/core/ingredient-lines.ts';
import type { ConcernTally } from '../src/core/vegan.ts';
import type { Decision, Decisions } from '../src/data/decisions.ts';
import type { Household } from '../src/data/household.ts';
import type { IngredientEntry, IngredientRegistry } from '../src/data/ingredients.ts';
import type { Note, Notes } from '../src/data/notes.ts';
import type { ParsedLine, ParsedLines } from '../src/data/parsed-lines.ts';
import type { ProductMemory, RememberedProduct, VeganLine } from '../src/data/product-memory.ts';
import type { Ingredient, Recipe } from '../src/data/recipes.ts';
import type { Weeks } from '../src/data/weeks.ts';
import type { Claude } from '../src/llm/claude.ts';
import type { LineParse } from '../src/llm/parse-ingredients.ts';
import type { BrandedFood, FdcFood, FoodData } from '../src/sources/fdc.ts';

export const household: Household = { id: 'h1', name: 'Home', members: ['uid1'], settings: {} };

export const parseOf = (ingredient: string, overrides: Partial<LineParse> = {}): LineParse => ({
  ingredient,
  amount: 1,
  unit: 'piece',
  packageSize: null,
  measuredAs: null,
  prep: null,
  brand: null,
  alternatives: [],
  alsoNeeded: [],
  optional: false,
  toTaste: false,
  doubt: null,
  ...overrides,
});

export const parsedLine = (
  line: Ingredient,
  parse: LineParse,
  source: ParsedLine['source'] = 'claude',
  recipeIds: string[] = [],
): ParsedLine => ({
  key: lineKey(line),
  line,
  parse,
  source,
  recipeIds,
});

export const recipeWith = (id: string, lines: Ingredient[]): Recipe => ({
  id,
  title: `Title of ${id}`,
  description: '',
  servings: 2,
  tags: [],
  ingredientGroups: [{ ingredients: lines }],
});

export const memoryParsedLines = (initial: ParsedLine[] = []) => {
  const stored = new Map(initial.map((parsed) => [parsed.key, parsed]));
  const store: ParsedLines = {
    list: async () => [...stored.values()],
    save: async (_householdId, lines) => {
      for (const parsed of lines) stored.set(parsed.key, parsed);
    },
  };
  return { store, stored };
};

export const answeringClaude = (answer: (prompt: string) => unknown) => {
  const prompts: string[] = [];
  const claude: Claude = {
    ask: async (_household, request) => {
      prompts.push(request.prompt);
      return request.schema.parse(answer(request.prompt));
    },
  };
  return { claude, prompts };
};

export const entry = (name: string, overrides: Partial<IngredientEntry> = {}): IngredientEntry => ({
  id: name.replace(/ /g, '-'),
  name,
  aliases: [],
  buying: null,
  comesWith: null,
  food: null,
  fdcQuery: null,
  storeSearch: null,
  gramsPerMl: null,
  unitWeights: {},
  ...overrides,
});

export const memoryIngredients = (initial: IngredientEntry[] = []) => {
  const stored = new Map(initial.map((saved) => [saved.id, saved]));
  const store: IngredientRegistry = {
    list: async () => [...stored.values()],
    save: async (_householdId, entries) => {
      for (const saved of entries) stored.set(saved.id, saved);
    },
    remove: async (_householdId, ids) => {
      for (const id of ids) stored.delete(id);
    },
  };
  return { store, stored };
};

export const note = (path: string, content: string): Note => ({ path, content, updatedBy: 'uid1', updatedAt: '2026-11-08T12:00:00.000Z' });

export const memoryNotes = (initial: Note[] = []) => {
  const stored = new Map(initial.map((saved) => [saved.path, saved]));
  const store: Notes = {
    list: async () => [...stored.values()],
    save: async (_householdId, saved) => {
      stored.set(saved.path, { ...saved, updatedAt: '2026-11-08T12:00:00.000Z' });
    },
    remove: async (_householdId, path) => {
      stored.delete(path);
    },
  };
  return { store, stored };
};

export const fdcFood = (fdcId: number, description: string, overrides: Partial<FdcFood> = {}): FdcFood => ({
  fdcId,
  description,
  dataType: 'SR Legacy',
  per100g: { kcal: 100, protein: 10, carbs: 5, sugar: 1, fiber: 2, fat: 4 },
  portions: [],
  ...overrides,
});

export const fakeFoodData = (byQuery: Record<string, FdcFood[]>, brandedByQuery: Record<string, BrandedFood[]> = {}) => {
  const queries: string[] = [];
  const foodData: FoodData = {
    candidates: async (query) => {
      queries.push(query);
      return byQuery[query] ?? [];
    },
    food: async (fdcId) => Object.values(byQuery).flat().find((food) => food.fdcId === fdcId) ?? null,
    branded: async (query) => {
      queries.push(query);
      return brandedByQuery[query] ?? [];
    },
  };
  return { foodData, queries };
};

export const memoryWeeks = (initial: Record<string, Record<string, unknown>> = {}) => {
  const docs = new Map(Object.entries(initial));
  const merge = (weekId: string, fields: Record<string, unknown>) => {
    docs.set(weekId, { ...docs.get(weekId), ...fields });
  };
  const store: Weeks = {
    findWeekDocs: async (_householdId, weekIds) => weekIds.flatMap((id) => (docs.has(id) ? [{ id, data: docs.get(id) }] : [])),
    savePlan: async (_householdId, weekId, plan, plannedBy) => merge(weekId, { ...plan, plannedBy }),
    saveHave: async (_householdId, weekId, answers) => {
      const have = { ...(docs.get(weekId)?.have as Record<string, unknown> | undefined) };
      for (const [name, answer] of Object.entries(answers)) {
        if (answer === null) delete have[name];
        else have[name] = answer;
      }
      merge(weekId, { have });
    },
    saveHungryroot: async (_householdId, weekId, hungryroot) => merge(weekId, { hungryroot }),
    lockBox: async (_householdId, weekId) => merge(weekId, { boxLocked: true }),
    saveInstacart: async (_householdId, weekId, instacart) => merge(weekId, { instacart }),
  };
  return { store, docs };
};

export const memoryProductMemory = (initial: RememberedProduct[] = []) => {
  const stored = new Map(initial.map((product) => [product.id, product]));
  const store: ProductMemory = {
    list: async () => [...stored.values()],
    save: async (_householdId, products) => {
      for (const product of products) stored.set(product.id, product);
    },
  };
  return { store, stored };
};

export const memoryVeganLine = () => {
  const tallies = new Map<string, ConcernTally>();
  const store: VeganLine = {
    tallies: async () => new Map(tallies),
    count: async (_householdId, concerns, ok) => {
      for (const concern of concerns) {
        const { ok: yes, notOk } = tallies.get(concern) ?? { ok: 0, notOk: 0 };
        tallies.set(concern, ok ? { ok: yes + 1, notOk } : { ok: yes, notOk: notOk + 1 });
      }
    },
  };
  return { store, tallies };
};

export const memoryDecisions = () => {
  const recorded: Decision[] = [];
  const store: Decisions = {
    record: async (_householdId, decision) => {
      recorded.push(decision);
    },
  };
  return { store, recorded };
};

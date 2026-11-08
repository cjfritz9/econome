import * as z from 'zod';

export const NOT_A_MEAL_TAG = 'not-a-meal';

const IngredientSchema = z.object({
  amount: z.number().positive(),
  unit: z.string(),
  name: z.string().min(1),
});

const IngredientGroupSchema = z.object({
  ingredients: z
    .array(IngredientSchema)
    .nullish()
    .transform((lines) => lines ?? []),
});

const RecipeDocSchema = z.object({
  title: z.string().min(1),
  description: z
    .string()
    .nullish()
    .transform((text) => text ?? ''),
  servings: z.number().positive(),
  tags: z
    .array(z.string())
    .nullish()
    .transform((tags) => tags ?? []),
  archived: z.boolean().nullish(),
  ingredientGroups: z
    .array(IngredientGroupSchema)
    .nullish()
    .transform((groups) => groups ?? []),
});

export type Ingredient = z.infer<typeof IngredientSchema>;

export interface Recipe {
  id: string;
  title: string;
  description: string;
  servings: number;
  tags: string[];
  ingredientGroups: { ingredients: Ingredient[] }[];
}

export interface SkippedRecipe {
  id: string;
  reason: string;
}

export interface RecipeLibrary {
  recipes: Recipe[];
  skipped: SkippedRecipe[];
}

export interface RecipeDoc {
  id: string;
  data: unknown;
}

export interface Recipes {
  listRecipeDocs: (householdId: string) => Promise<RecipeDoc[]>;
}

export const readLibrary = (docs: RecipeDoc[]): RecipeLibrary => {
  const library: RecipeLibrary = { recipes: [], skipped: [] };

  for (const { id, data } of docs) {
    const parsed = RecipeDocSchema.safeParse(data);
    if (!parsed.success) {
      library.skipped.push({ id, reason: `Can't be read:\n${z.prettifyError(parsed.error)}` });
      continue;
    }

    const { archived, ...recipe } = parsed.data;
    if (archived || recipe.tags.includes(NOT_A_MEAL_TAG)) continue;

    if (recipe.ingredientGroups.every((group) => group.ingredients.length === 0)) {
      library.skipped.push({ id, reason: 'Has no ingredients' });
      continue;
    }

    library.recipes.push({ id, ...recipe });
  }

  library.recipes.sort((a, b) => a.title.localeCompare(b.title));
  return library;
};

export const withTag = (recipes: Recipe[], tag: string): Recipe[] => {
  const wanted = tag.toLowerCase();
  return recipes.filter((recipe) => recipe.tags.some((t) => t.toLowerCase() === wanted));
};

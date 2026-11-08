import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.ts';
import type { Recipes } from './recipes.ts';

const RECIPE_LIMIT = 500;
const RECIPE_FIELDS = ['title', 'description', 'servings', 'tags', 'archived', 'ingredientGroups'];

export const firestoreRecipes = (db: Firestore): Recipes => ({
  listRecipeDocs: async (householdId) => {
    const snap = await db
      .collection(`households/${householdId}/recipes`)
      .select(...RECIPE_FIELDS)
      .limit(RECIPE_LIMIT)
      .get();
    if (snap.size === RECIPE_LIMIT) {
      logger.warn({ householdId, limit: RECIPE_LIMIT }, 'Recipe library hit the read limit; some recipes were not read');
    }
    return snap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
  },
});

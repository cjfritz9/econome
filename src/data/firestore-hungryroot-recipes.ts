import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { HungryrootRecipeSchema, type HungryrootRecipes } from './hungryroot-recipes.ts';

export const firestoreHungryrootRecipes = (db: Firestore): HungryrootRecipes => {
  const collection = (householdId: string) => db.collection(`households/${householdId}/hungryrootRecipes`);

  return {
    find: async (householdId, ids) => {
      if (ids.length === 0) return [];
      const snaps = await db.getAll(...ids.map((id) => collection(householdId).doc(id)));
      return snaps.filter((snap) => snap.exists).map((snap) => ({ id: snap.id, ...HungryrootRecipeSchema.parse(snap.data()) }));
    },

    save: async (householdId, records) => {
      const batch = db.batch();
      for (const { id, ...record } of records) {
        batch.set(collection(householdId).doc(id), { ...HungryrootRecipeSchema.parse(record), updatedAt: Timestamp.now() });
      }
      await batch.commit();
    },
  };
};

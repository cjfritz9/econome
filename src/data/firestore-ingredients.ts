import { Timestamp, type Firestore, type WriteBatch } from 'firebase-admin/firestore';
import { logger } from '../logger.ts';
import { IngredientEntrySchema, type IngredientRegistry } from './ingredients.ts';

const INGREDIENT_LIMIT = 2_000;
const BATCH_SIZE = 400;

export const firestoreIngredients = (db: Firestore): IngredientRegistry => {
  const collection = (householdId: string) => db.collection(`households/${householdId}/ingredients`);

  const inBatches = async <T>(items: T[], write: (batch: WriteBatch, item: T) => void) => {
    for (let start = 0; start < items.length; start += BATCH_SIZE) {
      const batch = db.batch();
      for (const item of items.slice(start, start + BATCH_SIZE)) write(batch, item);
      await batch.commit();
    }
  };

  return {
    list: async (householdId) => {
      const snap = await collection(householdId).limit(INGREDIENT_LIMIT).get();
      if (snap.size === INGREDIENT_LIMIT) {
        logger.warn({ householdId, limit: INGREDIENT_LIMIT }, 'Ingredient registry hit the read limit; some entries were not read');
      }
      return snap.docs.map((doc) => ({ id: doc.id, ...IngredientEntrySchema.parse(doc.data()) }));
    },

    save: async (householdId, entries) =>
      inBatches(entries, (batch, { id, ...entry }) =>
        batch.set(collection(householdId).doc(id), { ...IngredientEntrySchema.parse(entry), updatedAt: Timestamp.now() }),
      ),

    remove: async (householdId, ids) => inBatches(ids, (batch, id) => batch.delete(collection(householdId).doc(id))),
  };
};

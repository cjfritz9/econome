import type { Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';
import { logger } from '../logger.ts';
import { markedAgain, type HungryrootUnavailable, type UnavailableRecipe } from './hungryroot-unavailable.ts';

const LIMIT = 500;

const RecordSchema = z.object({
  title: z.string(),
  hungryrootId: z.number(),
  firstMarkedAt: z.string(),
  lastMarkedAt: z.string(),
  times: z.number(),
  lastMarkedBy: z.string(),
  lastWeek: z.string(),
});

export const firestoreHungryrootUnavailable = (db: Firestore): HungryrootUnavailable => {
  const records = (householdId: string) => db.collection(`households/${householdId}/hungryrootUnavailable`);

  return {
    list: async (householdId) => {
      const snap = await records(householdId).limit(LIMIT).get();
      if (snap.size === LIMIT) logger.warn({ householdId, limit: LIMIT }, 'Unavailable Hungryroot recipes hit the read limit');
      return snap.docs.flatMap((doc): UnavailableRecipe[] => {
        const parsed = RecordSchema.safeParse(doc.data());
        return parsed.success ? [{ id: doc.id, ...parsed.data }] : [];
      });
    },

    mark: async (householdId, mark) =>
      db.runTransaction(async (transaction) => {
        const ref = records(householdId).doc(mark.id);
        const snap = await transaction.get(ref);
        const parsed = RecordSchema.safeParse(snap.data());
        const record = markedAgain(parsed.success ? { id: mark.id, ...parsed.data } : undefined, mark);
        transaction.set(ref, RecordSchema.parse(record));
        return record;
      }),

    clear: async (householdId, ids) => {
      if (ids.length === 0) return;
      const batch = db.batch();
      for (const id of ids) batch.delete(records(householdId).doc(id));
      await batch.commit();
    },
  };
};

import type { Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';
import { logger } from '../logger.ts';
import { missedAgain, type InstacartNotAdded, type NotAdded } from './instacart-not-added.ts';

const LIMIT = 500;

const RecordSchema = z.object({
  name: z.string().nullable(),
  times: z.number(),
  firstAt: z.string(),
  lastAt: z.string(),
  lastWeek: z.string(),
  said: z.string().nullable(),
});

const parsedRecord = (productId: string, data: unknown): NotAdded | undefined => {
  const parsed = RecordSchema.safeParse(data);
  return parsed.success ? { productId, ...parsed.data } : undefined;
};

export const firestoreInstacartNotAdded = (db: Firestore): InstacartNotAdded => {
  const records = (householdId: string) => db.collection(`households/${householdId}/instacartNotAdded`);

  return {
    list: async (householdId) => {
      const snap = await records(householdId).limit(LIMIT).get();
      if (snap.size === LIMIT) logger.warn({ householdId, limit: LIMIT }, 'Instacart products that did not add hit the read limit');
      return snap.docs.flatMap((doc) => parsedRecord(doc.id, doc.data()) ?? []);
    },

    record: async (householdId, { week, at, missed, landed }) => {
      if (missed.length === 0 && landed.length === 0) return;
      await db.runTransaction(async (transaction) => {
        const refs = [...missed.map(({ productId }) => productId), ...landed].map((productId) => records(householdId).doc(productId));
        const snaps = await transaction.getAll(...refs);
        const existing = new Map(snaps.filter((snap) => snap.exists).map((snap) => [snap.id, parsedRecord(snap.id, snap.data())]));
        for (const miss of missed) {
          const { productId, ...record } = missedAgain(existing.get(miss.productId), miss, week, at);
          transaction.set(records(householdId).doc(productId), RecordSchema.parse(record));
        }
        for (const productId of landed.filter((id) => existing.has(id))) transaction.delete(records(householdId).doc(productId));
      });
    },
  };
};

import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';
import { logger } from '../logger.ts';
import { RememberedProductSchema, type ProductMemory, type VeganLine } from './product-memory.ts';

const PRODUCT_LIMIT = 2_000;
const CONCERN_LIMIT = 500;

const concernId = (concern: string) => concern.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

export const firestoreProductMemory = (db: Firestore): ProductMemory => {
  const collection = (householdId: string) => db.collection(`households/${householdId}/products`);

  return {
    list: async (householdId) => {
      const snap = await collection(householdId).limit(PRODUCT_LIMIT).get();
      if (snap.size === PRODUCT_LIMIT) logger.warn({ householdId, limit: PRODUCT_LIMIT }, 'Product memory hit the read limit');
      return snap.docs.map((doc) => ({ id: doc.id, ...RememberedProductSchema.parse(doc.data()) }));
    },

    save: async (householdId, products) => {
      const batch = db.batch();
      for (const { id, ...product } of products) {
        batch.set(collection(householdId).doc(id), { ...RememberedProductSchema.parse(product), updatedAt: Timestamp.now() });
      }
      await batch.commit();
    },
  };
};

export const firestoreVeganLine = (db: Firestore): VeganLine => {
  const collection = (householdId: string) => db.collection(`households/${householdId}/veganConcerns`);

  return {
    tallies: async (householdId) => {
      const snap = await collection(householdId).limit(CONCERN_LIMIT).get();
      const Tally = z.object({ concern: z.string(), ok: z.number(), notOk: z.number() });
      return new Map(snap.docs.map((doc) => Tally.parse(doc.data())).map(({ concern, ok, notOk }) => [concern, { ok, notOk }]));
    },

    count: async (householdId, concerns, ok) => {
      const batch = db.batch();
      for (const concern of concerns) {
        batch.set(
          collection(householdId).doc(concernId(concern)),
          { concern, [ok ? 'ok' : 'notOk']: FieldValue.increment(1), [ok ? 'notOk' : 'ok']: FieldValue.increment(0), updatedAt: Timestamp.now() },
          { merge: true },
        );
      }
      await batch.commit();
    },
  };
};

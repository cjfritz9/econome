import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { logger } from '../logger.ts';
import { ParsedLineSchema, type ParsedLines } from './parsed-lines.ts';

const PARSED_LINE_LIMIT = 5_000;
const BATCH_SIZE = 400;

export const firestoreParsedLines = (db: Firestore): ParsedLines => {
  const collection = (householdId: string) => db.collection(`households/${householdId}/parsedLines`);

  return {
    list: async (householdId) => {
      const snap = await collection(householdId).limit(PARSED_LINE_LIMIT).get();
      if (snap.size === PARSED_LINE_LIMIT) {
        logger.warn({ householdId, limit: PARSED_LINE_LIMIT }, 'Parsed lines hit the read limit; some were not read');
      }
      return snap.docs.map((doc) => ({ key: doc.id, ...ParsedLineSchema.parse(doc.data()) }));
    },

    save: async (householdId, lines) => {
      for (let start = 0; start < lines.length; start += BATCH_SIZE) {
        const batch = db.batch();
        for (const { key, line, parse, source, recipeIds } of lines.slice(start, start + BATCH_SIZE)) {
          batch.set(collection(householdId).doc(key), { line, parse, source, recipeIds, updatedAt: Timestamp.now() });
        }
        await batch.commit();
      }
    },
  };
};

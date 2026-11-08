import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';
import type { SpendLedger } from '../llm/claude.ts';

const SpendDocSchema = z.object({ usd: z.number() });

export const firestoreSpend = (db: Firestore): SpendLedger => {
  const dayDoc = (householdId: string, day: string) => db.doc(`households/${householdId}/spend/${day}`);

  return {
    spentOn: async (householdId, day) => {
      const snap = await dayDoc(householdId, day).get();
      return snap.exists ? SpendDocSchema.parse(snap.data()).usd : 0;
    },

    record: async (householdId, day, model, usd, usage) => {
      await dayDoc(householdId, day).set(
        {
          usd: FieldValue.increment(usd),
          calls: FieldValue.increment(1),
          inputTokens: FieldValue.increment(
            usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
          ),
          outputTokens: FieldValue.increment(usage.output_tokens),
          byModel: { [model]: FieldValue.increment(usd) },
          updatedAt: Timestamp.now(),
        },
        { merge: true },
      );
    },
  };
};

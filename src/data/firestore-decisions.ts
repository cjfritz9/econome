import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { Decisions } from './decisions.ts';

export const firestoreDecisions = (db: Firestore): Decisions => ({
  record: async (householdId, decision) => {
    await db.collection(`households/${householdId}/decisions`).add({ ...decision, at: Timestamp.now() });
  },
});

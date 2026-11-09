import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { Weeks } from './weeks.ts';

export const firestoreWeeks = (db: Firestore): Weeks => {
  const weeks = (householdId: string) => db.collection(`households/${householdId}/weeks`);

  return {
    findWeekDocs: async (householdId, weekIds) => {
      if (weekIds.length === 0) return [];
      const snaps = await db.getAll(...weekIds.map((id) => weeks(householdId).doc(id)));
      return snaps.filter((snap) => snap.exists).map((snap) => ({ id: snap.id, data: snap.data() }));
    },

    savePlan: async (householdId, weekId, { meals, hungryroot, targets }, plannedBy) => {
      await weeks(householdId)
        .doc(weekId)
        .set(
          { meals, ...(hungryroot && { hungryroot }), ...(targets && { targets }), plannedBy, plannedAt: Timestamp.now() },
          { merge: true },
        );
    },
  };
};

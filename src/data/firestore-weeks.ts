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

    saveMeals: async (householdId, weekId, meals, plannedBy) => {
      await weeks(householdId)
        .doc(weekId)
        .set({ meals, plannedBy, plannedAt: Timestamp.now() }, { merge: true });
    },
  };
};

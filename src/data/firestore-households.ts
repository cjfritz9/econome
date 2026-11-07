import type { Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';
import type { Households } from './household.ts';

const HouseholdDocSchema = z.object({
  name: z.string(),
  members: z.array(z.string()),
  econome: z.unknown().optional(),
});

const UserDocSchema = z.object({
  householdId: z.string().optional(),
  displayName: z.string().optional(),
  email: z.string().optional(),
});

export const firestoreHouseholds = (db: Firestore): Households => {
  const users = db.collection('users');
  const households = db.collection('households');

  return {
    findUserHouseholdId: async (uid) => {
      const snap = await users.doc(uid).get();
      return snap.exists ? UserDocSchema.parse(snap.data()).householdId : undefined;
    },

    findHousehold: async (householdId) => {
      const snap = await households.doc(householdId).get();
      if (!snap.exists) return undefined;
      const data = HouseholdDocSchema.parse(snap.data());
      return { id: snap.id, ...data };
    },

    findMemberProfiles: async (uids) => {
      if (uids.length === 0) return [];
      const snaps = await db.getAll(...uids.map((uid) => users.doc(uid)));
      return snaps.map((snap) => {
        const data = snap.exists ? UserDocSchema.parse(snap.data()) : {};
        return { uid: snap.id, name: data.displayName || data.email || snap.id };
      });
    },

    updateSettings: async (householdId, paths) => {
      await households.doc(householdId).update(paths);
    },
  };
};

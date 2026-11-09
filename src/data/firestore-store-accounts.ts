import type { Firestore } from 'firebase-admin/firestore';
import { StoreAccountSchema, type StoreAccounts } from './store-accounts.ts';

export const firestoreStoreAccounts = (db: Firestore): StoreAccounts => {
  const doc = (householdId: string) => db.doc(`households/${householdId}/storeAccounts/kroger`);

  return {
    find: async (householdId) => {
      const snap = await doc(householdId).get();
      return snap.exists ? StoreAccountSchema.parse(snap.data()) : null;
    },

    save: async (householdId, account) => {
      await doc(householdId).set(StoreAccountSchema.parse(account));
    },

    remove: async (householdId) => {
      await doc(householdId).delete();
    },

    claim: (householdId, holder, now, leaseMs) =>
      db.runTransaction(async (transaction) => {
        const snap = await transaction.get(doc(householdId));
        if (!snap.exists) return null;
        const account = StoreAccountSchema.parse(snap.data());
        if (account.lease && account.lease.holder !== holder && account.lease.until > now) return 'busy';
        transaction.update(doc(householdId), { lease: { holder, until: now + leaseMs } });
        return account;
      }),

    release: (householdId, holder, refresh) =>
      db.runTransaction(async (transaction) => {
        const snap = await transaction.get(doc(householdId));
        if (!snap.exists) return;
        const account = StoreAccountSchema.parse(snap.data());
        if (account.lease?.holder !== holder) return;
        transaction.update(doc(householdId), { refresh, lease: null });
      }),
  };
};

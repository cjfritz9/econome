import type { Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';
import { AccessError, type Access } from './access.ts';

const AccessDocSchema = z.object({ features: z.array(z.string()) });

export const firestoreAccess = (db: Firestore): Access => ({
  featuresOf: async (uid) => {
    const snap = await db.collection('access').doc(uid).get();
    if (!snap.exists) return [];
    const parsed = AccessDocSchema.safeParse(snap.data());
    if (!parsed.success) {
      throw new AccessError(`This account's access record can't be read, so it can't be checked:\n${z.prettifyError(parsed.error)}`);
    }
    return parsed.data.features;
  },
});

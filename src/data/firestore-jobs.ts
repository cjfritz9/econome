import type { Firestore } from 'firebase-admin/firestore';
import { RECENT_JOBS, type Jobs } from './jobs.ts';

export const firestoreJobs = (db: Firestore): Jobs => {
  const jobs = (householdId: string) => db.collection(`households/${householdId}/jobs`);

  return {
    recent: async (householdId, since) => {
      const snap = await jobs(householdId).where('startedAt', '>=', since).orderBy('startedAt', 'desc').limit(RECENT_JOBS).get();
      return snap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
    },

    find: async (householdId, jobId) => {
      const snap = await jobs(householdId).doc(jobId).get();
      return snap.exists ? { id: snap.id, data: snap.data() } : undefined;
    },

    create: async (householdId, jobId, job) => {
      await jobs(householdId).doc(jobId).create(job);
    },

    update: async (householdId, jobId, { state, error, run, found }) => {
      await jobs(householdId)
        .doc(jobId)
        .set(
          { ...(state && { state }), ...(error !== undefined && { error }), ...(run && { run }), ...(found && { found }) },
          { merge: true },
        );
    },
  };
};

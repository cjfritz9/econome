import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export const connectFirebase = (projectId: string) => {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return { db: getFirestore(app), auth: getAuth(app) };
};

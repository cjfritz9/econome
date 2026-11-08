import { createHash } from 'node:crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import * as z from 'zod';
import { logger } from '../logger.ts';
import type { Notes } from './notes.ts';

const NOTE_LIMIT = 500;

const NoteDocSchema = z.object({
  path: z.string(),
  content: z.string(),
  updatedBy: z.string(),
  updatedAt: z.instanceof(Timestamp),
});

const noteId = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 32);

export const firestoreNotes = (db: Firestore): Notes => {
  const collection = (householdId: string) => db.collection(`households/${householdId}/notes`);

  return {
    list: async (householdId) => {
      const snap = await collection(householdId).limit(NOTE_LIMIT).get();
      if (snap.size === NOTE_LIMIT) logger.warn({ householdId, limit: NOTE_LIMIT }, 'Notes hit the read limit; some were not read');
      return snap.docs.map((doc) => {
        const { updatedAt, ...note } = NoteDocSchema.parse(doc.data());
        return { ...note, updatedAt: updatedAt.toDate().toISOString() };
      });
    },

    save: async (householdId, { path, content, updatedBy }) => {
      await collection(householdId).doc(noteId(path)).set({ path, content, updatedBy, updatedAt: Timestamp.now() });
    },

    remove: async (householdId, path) => {
      await collection(householdId).doc(noteId(path)).delete();
    },
  };
};

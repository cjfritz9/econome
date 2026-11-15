import { FieldPath, FieldValue, Timestamp, type Firestore, type WriteBatch } from 'firebase-admin/firestore';
import * as z from 'zod';
import { logger } from '../logger.ts';
import type { HungryrootCatalogStore, StoredCatalogEntry } from './hungryroot-catalog.ts';

const RECIPES = 'hungryroot-recipes';
const PAGE = 1_000;
const MAX_PAGES = 20;
const BATCH = 400;

const EntrySchema = z.object({
  hungryroot: z.object({ hash: z.string().default(''), gone: z.boolean().default(false) }).optional(),
});

export const firestoreHungryrootCatalog = (db: Firestore): HungryrootCatalogStore => {
  const recipes = db.collection(RECIPES);
  const home = db.doc('econome/hungryroot');

  const inBatches = async <T>(items: T[], write: (batch: WriteBatch, item: T) => void) => {
    for (let start = 0; start < items.length; start += BATCH) {
      const batch = db.batch();
      for (const item of items.slice(start, start + BATCH)) write(batch, item);
      await batch.commit();
    }
  };

  return {
    entries: async () => {
      const entries = new Map<string, StoredCatalogEntry>();
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = recipes.orderBy(FieldPath.documentId()).select('hungryroot.hash', 'hungryroot.gone').limit(PAGE);
        const snap = await (after ? query.startAfter(after) : query).get();
        for (const doc of snap.docs) {
          const { hungryroot } = EntrySchema.parse(doc.data());
          entries.set(doc.id, { hash: hungryroot?.hash ?? '', gone: hungryroot?.gone ?? false });
        }
        if (snap.size < PAGE) return entries;
        after = snap.docs.at(-1)?.id;
      }
      logger.warn({ read: entries.size }, 'The Hungryroot catalog hit its read limit; some recipes were not compared');
      return entries;
    },

    saveRecipes: async (changes) => {
      const now = Timestamp.now();
      await inBatches(changes, (batch, { recipe, hash, isNew }) => {
        const { id, ...fields } = recipe;
        const body = { ...fields, hungryroot: { ...fields.hungryroot, hash }, updatedAt: now };
        if (isNew) {
          batch.set(recipes.doc(id), { ...body, createdAt: now });
        } else {
          batch.update(recipes.doc(id), {
            ...body,
            images: fields.images ?? FieldValue.delete(),
            nutrition: fields.nutrition ?? FieldValue.delete(),
          });
        }
      });
    },

    markGone: async (ids) => {
      const now = Timestamp.now();
      await inBatches(ids, (batch, id) => batch.update(recipes.doc(id), { 'hungryroot.gone': true, 'hungryroot.goneAt': now, updatedAt: now }));
    },

    saveProducts: async (products) => {
      const now = Timestamp.now();
      await inBatches(products, (batch, product) =>
        batch.set(home.collection('products').doc(String(product.id)), { ...product, updatedAt: now }),
      );
    },

    saveRun: async (run) => {
      await home.set({ lastRun: { ...run, at: Timestamp.now() } }, { merge: true });
    },
  };
};

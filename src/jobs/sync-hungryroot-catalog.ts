import { connectFirebase } from '../data/firebase.ts';
import { firestoreHungryrootCatalog } from '../data/firestore-hungryroot-catalog.ts';
import { logger } from '../logger.ts';
import { SERVER_VERSION } from '../mcp/server.ts';
import { syncHungryrootCatalog } from '../services/hungryroot-catalog-sync.ts';
import { hungryrootCatalog } from '../sources/hungryroot.ts';

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) throw new Error('Set FIREBASE_PROJECT_ID to the Firebase project the catalog goes in.');

const { db } = connectFirebase(projectId);
try {
  const run = await syncHungryrootCatalog({ source: hungryrootCatalog(SERVER_VERSION), store: firestoreHungryrootCatalog(db) });
  if (run.imageHostsLeftOff.length > 0) logger.warn({ hosts: run.imageHostsLeftOff }, 'Some recipe images come from hosts Mise does not allow, so they were left off');
  if (!run.complete) logger.warn({ read: run.read, of: run.of }, 'The pull missed recipes, so none were marked gone');
  logger.info({ run }, 'Hungryroot catalog synced');
} catch (error) {
  logger.error({ err: error }, 'Hungryroot catalog sync failed');
  process.exitCode = 1;
}

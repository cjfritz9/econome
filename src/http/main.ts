import { serve } from '@hono/node-server';
import { loadHttpConfig } from '../config.ts';
import { connectFirebase } from '../data/firebase.ts';
import { firestoreAccess } from '../data/firestore-access.ts';
import { firestoreHouseholds } from '../data/firestore-households.ts';
import { firestoreSpend } from '../data/firestore-spend.ts';
import { firestoreWeeks } from '../data/firestore-weeks.ts';
import { logger } from '../logger.ts';
import { routinesClient } from '../sources/routines.ts';
import { createApp } from './app.ts';

const main = () => {
  const config = loadHttpConfig(process.env);
  const { db, auth } = connectFirebase(config.firebaseProjectId);
  const app = createApp({
    verifier: { uidOf: async (idToken) => (await auth.verifyIdToken(idToken)).uid },
    access: firestoreAccess(db),
    households: firestoreHouseholds(db),
    spend: firestoreSpend(db),
    weeks: firestoreWeeks(db),
    routines: routinesClient(),
    fillRoutine: config.fillRoutine,
    routineSecret: config.routineSecret,
    allowedOrigins: config.allowedOrigins,
  });
  serve({ fetch: app.fetch, port: config.port }, ({ port }) => logger.info({ port }, 'Économe HTTP server ready'));
};

try {
  main();
} catch (error: unknown) {
  logger.fatal({ err: error }, 'Économe HTTP server failed to start');
  process.exit(1);
}

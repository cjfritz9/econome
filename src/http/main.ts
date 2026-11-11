import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';
import { loadHttpConfig } from '../config.ts';
import { connectFirebase } from '../data/firebase.ts';
import { firestoreAccess } from '../data/firestore-access.ts';
import { firestoreDecisions } from '../data/firestore-decisions.ts';
import { firestoreHouseholds } from '../data/firestore-households.ts';
import { firestoreIngredients } from '../data/firestore-ingredients.ts';
import { firestoreJobs } from '../data/firestore-jobs.ts';
import { firestoreNotes } from '../data/firestore-notes.ts';
import { firestoreParsedLines } from '../data/firestore-parsed-lines.ts';
import { firestoreProductMemory, firestoreVeganLine } from '../data/firestore-product-memory.ts';
import { firestoreRecipes } from '../data/firestore-recipes.ts';
import { firestoreSpend } from '../data/firestore-spend.ts';
import { firestoreWeeks } from '../data/firestore-weeks.ts';
import { anthropicSender } from '../llm/anthropic.ts';
import { createClaude } from '../llm/claude.ts';
import { logger } from '../logger.ts';
import { fdcClient } from '../sources/fdc.ts';
import { routinesClient } from '../sources/routines.ts';
import { createApp } from './app.ts';

const main = () => {
  const config = loadHttpConfig(process.env);
  const { db, auth } = connectFirebase(config.firebaseProjectId);
  const spend = firestoreSpend(db);
  const app = createApp({
    verifier: { uidOf: async (idToken) => (await auth.verifyIdToken(idToken)).uid },
    access: firestoreAccess(db),
    households: firestoreHouseholds(db),
    spend,
    weeks: firestoreWeeks(db),
    recipes: firestoreRecipes(db),
    parsedLines: firestoreParsedLines(db),
    ingredients: firestoreIngredients(db),
    notes: firestoreNotes(db),
    fdc: fdcClient(config.fdcApiKey),
    productMemory: firestoreProductMemory(db),
    veganLine: firestoreVeganLine(db),
    decisions: firestoreDecisions(db),
    jobs: firestoreJobs(db),
    claude: createClaude({ send: anthropicSender(new Anthropic({ apiKey: config.anthropicApiKey })), ledger: spend }),
    routines: routinesClient(),
    fillRoutine: config.fillRoutine,
    researchRoutine: config.researchRoutine,
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

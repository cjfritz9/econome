import Anthropic from '@anthropic-ai/sdk';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from '../config.ts';
import { connectFirebase } from '../data/firebase.ts';
import { firestoreAccess } from '../data/firestore-access.ts';
import { firestoreDecisions } from '../data/firestore-decisions.ts';
import { firestoreHouseholds } from '../data/firestore-households.ts';
import { firestoreIngredients } from '../data/firestore-ingredients.ts';
import { firestoreNotes } from '../data/firestore-notes.ts';
import { firestoreParsedLines } from '../data/firestore-parsed-lines.ts';
import { firestoreRecipes } from '../data/firestore-recipes.ts';
import { firestoreSpend } from '../data/firestore-spend.ts';
import { firestoreWeeks } from '../data/firestore-weeks.ts';
import { anthropicSender } from '../llm/anthropic.ts';
import { createClaude } from '../llm/claude.ts';
import { logger } from '../logger.ts';
import { firestoreHungryrootRecipes } from '../data/firestore-hungryroot-recipes.ts';
import { firestoreProductMemory, firestoreVeganLine } from '../data/firestore-product-memory.ts';
import { fdcClient } from '../sources/fdc.ts';
import { hungryrootCatalog } from '../sources/hungryroot.ts';
import { krogerClient } from '../sources/kroger.ts';
import { createServer, SERVER_VERSION } from './server.ts';

const main = async () => {
  const config = loadConfig(process.env);
  const { db, auth } = connectFirebase(config.firebaseProjectId);
  const actingUser = await auth.getUserByEmail(config.actingEmail);
  const spend = firestoreSpend(db);

  const server = createServer({
    access: firestoreAccess(db),
    households: firestoreHouseholds(db),
    recipes: firestoreRecipes(db),
    weeks: firestoreWeeks(db),
    spend,
    parsedLines: firestoreParsedLines(db),
    ingredients: firestoreIngredients(db),
    notes: firestoreNotes(db),
    fdc: fdcClient(config.fdcApiKey),
    hungryroot: hungryrootCatalog(SERVER_VERSION),
    hungryrootRecipes: firestoreHungryrootRecipes(db),
    kroger: config.kroger && krogerClient({ ...config.kroger, version: SERVER_VERSION }),
    productMemory: firestoreProductMemory(db),
    veganLine: firestoreVeganLine(db),
    decisions: firestoreDecisions(db),
    claude: createClaude({ send: anthropicSender(new Anthropic({ apiKey: config.anthropicApiKey })), ledger: spend }),
    actingUid: actingUser.uid,
  });
  await server.connect(new StdioServerTransport());
  logger.info({ uid: actingUser.uid }, 'Économe MCP server ready');
};

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Économe MCP server failed to start');
  process.exit(1);
});

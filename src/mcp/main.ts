import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from '../config.ts';
import { connectFirebase } from '../data/firebase.ts';
import { firestoreHouseholds } from '../data/firestore-households.ts';
import { firestoreRecipes } from '../data/firestore-recipes.ts';
import { logger } from '../logger.ts';
import { createServer } from './server.ts';

const main = async () => {
  const config = loadConfig(process.env);
  const { db, auth } = connectFirebase(config.firebaseProjectId);
  const actingUser = await auth.getUserByEmail(config.actingEmail);

  const server = createServer({
    households: firestoreHouseholds(db),
    recipes: firestoreRecipes(db),
    actingUid: actingUser.uid,
  });
  await server.connect(new StdioServerTransport());
  logger.info({ uid: actingUser.uid }, 'Économe MCP server ready');
};

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Économe MCP server failed to start');
  process.exit(1);
});

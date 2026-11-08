import Anthropic from '@anthropic-ai/sdk';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from '../config.ts';
import { connectFirebase } from '../data/firebase.ts';
import { firestoreDecisions } from '../data/firestore-decisions.ts';
import { firestoreHouseholds } from '../data/firestore-households.ts';
import { firestoreParsedLines } from '../data/firestore-parsed-lines.ts';
import { firestoreRecipes } from '../data/firestore-recipes.ts';
import { firestoreSpend } from '../data/firestore-spend.ts';
import { firestoreWeeks } from '../data/firestore-weeks.ts';
import { anthropicSender } from '../llm/anthropic.ts';
import { createClaude } from '../llm/claude.ts';
import { logger } from '../logger.ts';
import { createServer } from './server.ts';

const main = async () => {
  const config = loadConfig(process.env);
  const { db, auth } = connectFirebase(config.firebaseProjectId);
  const actingUser = await auth.getUserByEmail(config.actingEmail);
  const spend = firestoreSpend(db);

  const server = createServer({
    households: firestoreHouseholds(db),
    recipes: firestoreRecipes(db),
    weeks: firestoreWeeks(db),
    spend,
    parsedLines: firestoreParsedLines(db),
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

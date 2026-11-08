import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { requireHousehold, type Households } from '../data/household.ts';
import { NOT_A_MEAL_TAG, readLibrary, withTag, type Recipes } from '../data/recipes.ts';
import { SettingsSchema, toUpdatePaths, withDefaults } from '../data/settings.ts';

export interface ServerDeps {
  households: Households;
  recipes: Recipes;
  actingUid: string;
}

const jsonResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

export const createServer = ({ households, recipes, actingUid }: ServerDeps) => {
  const server = new McpServer({ name: 'econome', version: '0.2.0' });

  server.registerTool(
    'get_household',
    {
      description: "Show the household Économe is working for: its name, its members, and Économe's settings.",
    },
    async () => {
      const household = await requireHousehold(households, actingUid);
      const members = await households.findMemberProfiles(household.members);
      return jsonResult({
        id: household.id,
        name: household.name,
        members,
        settings: withDefaults(household.settings),
      });
    },
  );

  server.registerTool(
    'update_settings',
    {
      description:
        "Change Économe's household settings. Only the fields given are changed; everything else is left as it is.",
      inputSchema: SettingsSchema,
    },
    async (changes) => {
      const household = await requireHousehold(households, actingUid);
      const paths = toUpdatePaths(changes);
      if (Object.keys(paths).length === 0) throw new Error('No settings were given to change.');

      await households.updateSettings(household.id, paths);
      const updated = await requireHousehold(households, actingUid);
      return jsonResult(withDefaults(updated.settings));
    },
  );

  server.registerTool(
    'list_recipes',
    {
      description: `List the household's Mise recipes that can be planned: id, title, description, servings and tags. Archived recipes and anything tagged ${NOT_A_MEAL_TAG} are left out. Recipes Économe can't use are listed under "skipped" with the reason, to be fixed in Mise.`,
      inputSchema: z.object({
        tag: z.string().optional().describe('Only list recipes with this tag, in any letter case'),
      }),
    },
    async ({ tag }) => {
      const household = await requireHousehold(households, actingUid);
      const library = readLibrary(await recipes.listRecipeDocs(household.id));
      const listed = tag ? withTag(library.recipes, tag) : library.recipes;
      return jsonResult({
        recipes: listed.map(({ id, title, description, servings, tags }) => ({ id, title, description, servings, tags })),
        ...(library.skipped.length > 0 && { skipped: library.skipped }),
      });
    },
  );

  return server;
};

import { McpServer } from '@modelcontextprotocol/server';
import { requireHousehold, type Households } from '../data/household.ts';
import { SettingsSchema, toUpdatePaths, withDefaults } from '../data/settings.ts';

export interface ServerDeps {
  households: Households;
  actingUid: string;
}

const jsonResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

export const createServer = ({ households, actingUid }: ServerDeps) => {
  const server = new McpServer({ name: 'econome', version: '0.1.0' });

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

  return server;
};

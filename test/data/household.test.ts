import { describe, expect, it } from 'vitest';
import {
  NO_HOUSEHOLD_MESSAGE,
  NOT_A_MEMBER_MESSAGE,
  requireHousehold,
  type HouseholdRecord,
} from '../../src/data/household.ts';

const storeWith = (userHouseholds: Record<string, string>, households: Record<string, HouseholdRecord>) => ({
  findUserHouseholdId: async (uid: string) => userHouseholds[uid],
  findHousehold: async (householdId: string) => households[householdId],
});

const home: HouseholdRecord = { id: 'h1', name: 'Home', members: ['uid1', 'uid2'] };

describe('requireHousehold', () => {
  it('returns the household for a member, with its settings parsed', async () => {
    const store = storeWith({ uid1: 'h1' }, { h1: { ...home, econome: { timezone: 'America/New_York' } } });

    await expect(requireHousehold(store, 'uid1')).resolves.toEqual({
      id: 'h1',
      name: 'Home',
      members: ['uid1', 'uid2'],
      settings: { timezone: 'America/New_York' },
    });
  });

  it('returns empty settings when Économe has stored none yet', async () => {
    const household = await requireHousehold(storeWith({ uid1: 'h1' }, { h1: home }), 'uid1');

    expect(household.settings).toEqual({});
  });

  it('asks to set up a household when the user has none', async () => {
    await expect(requireHousehold(storeWith({}, { h1: home }), 'uid1')).rejects.toThrow(NO_HOUSEHOLD_MESSAGE);
  });

  it('asks to set up a household when the household record is gone', async () => {
    await expect(requireHousehold(storeWith({ uid1: 'h1' }, {}), 'uid1')).rejects.toThrow(NO_HOUSEHOLD_MESSAGE);
  });

  it('refuses a user whose profile points at a household they are not in', async () => {
    const store = storeWith({ guest: 'h1' }, { h1: home });

    await expect(requireHousehold(store, 'guest')).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
  });

  it('refuses everyone for a household with no members left', async () => {
    const store = storeWith({ uid1: 'h1' }, { h1: { ...home, members: [] } });

    await expect(requireHousehold(store, 'uid1')).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
  });

  it('reports invalid stored settings instead of ignoring them', async () => {
    const store = storeWith({ uid1: 'h1' }, { h1: { ...home, econome: { timezone: 'Mars/Olympus' } } });

    await expect(requireHousehold(store, 'uid1')).rejects.toThrow(/settings on this household are invalid/);
  });
});

import { householdToday } from '../core/calendar.ts';
import { AccessError } from './access.ts';
import { parseSettings, withDefaults, type Settings } from './settings.ts';

export interface HouseholdRecord {
  id: string;
  name: string;
  members: string[];
  econome?: unknown;
}

export interface MemberProfile {
  uid: string;
  name: string;
}

export interface Households {
  findUserHouseholdId: (uid: string) => Promise<string | undefined>;
  findHousehold: (householdId: string) => Promise<HouseholdRecord | undefined>;
  findMemberProfiles: (uids: string[]) => Promise<MemberProfile[]>;
  updateSettings: (householdId: string, paths: Record<string, unknown>) => Promise<void>;
}

export interface Household {
  id: string;
  name: string;
  members: string[];
  settings: Settings;
}

export const NO_HOUSEHOLD_MESSAGE = 'Set up or join a household in Mise first.';
export const NOT_A_MEMBER_MESSAGE =
  "Your Mise profile points at a household you're not a member of. Leave it and join again in Mise.";

export const householdOf = (record: HouseholdRecord): Household => ({
  id: record.id,
  name: record.name,
  members: record.members,
  settings: parseSettings(record.econome),
});

export const requireHousehold = async (
  households: Pick<Households, 'findUserHouseholdId' | 'findHousehold'>,
  uid: string,
): Promise<Household> => {
  const householdId = await households.findUserHouseholdId(uid);
  if (!householdId) throw new AccessError(NO_HOUSEHOLD_MESSAGE);

  const record = await households.findHousehold(householdId);
  if (!record) throw new AccessError(NO_HOUSEHOLD_MESSAGE);
  if (!record.members.includes(uid)) throw new AccessError(NOT_A_MEMBER_MESSAGE);
  return householdOf(record);
};

export interface DailySpend {
  spentOn: (householdId: string, day: string) => Promise<number>;
}

export const describeHousehold = async (
  household: Household,
  households: Pick<Households, 'findMemberProfiles'>,
  spend: DailySpend,
  now = new Date(),
) => {
  const settings = withDefaults(household.settings);
  const [members, spentToday] = await Promise.all([
    households.findMemberProfiles(household.members),
    spend.spentOn(household.id, householdToday(settings.timezone, now)),
  ]);
  return {
    id: household.id,
    name: household.name,
    members,
    settings,
    claudeSpendToday: { usd: Number(spentToday.toFixed(4)), cap: settings.dailyClaudeCapUsd },
  };
};

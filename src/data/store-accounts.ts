import * as z from 'zod';

export const SealedSchema = z.object({ iv: z.string(), tag: z.string(), data: z.string() });

export const StoreAccountSchema = z.object({
  connectedBy: z.string(),
  connectedAt: z.string(),
  refresh: SealedSchema,
  lease: z.object({ holder: z.string(), until: z.number() }).nullable().default(null),
});

export type StoreAccount = z.infer<typeof StoreAccountSchema>;

export interface StoreAccounts {
  find: (householdId: string) => Promise<StoreAccount | null>;
  save: (householdId: string, account: StoreAccount) => Promise<void>;
  remove: (householdId: string) => Promise<void>;
  claim: (householdId: string, holder: string, now: number, leaseMs: number) => Promise<StoreAccount | 'busy' | null>;
  release: (householdId: string, holder: string, refresh: StoreAccount['refresh']) => Promise<void>;
}

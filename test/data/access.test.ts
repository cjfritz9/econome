import { describe, expect, it } from 'vitest';
import { AccessError, requireFeature, type Access } from '../../src/data/access.ts';

const accessWith = (features: Record<string, string[]>): Access => ({ featuresOf: async (uid) => features[uid] ?? [] });

describe('requireFeature', () => {
  it('lets through an account that has the feature', async () => {
    await expect(requireFeature(accessWith({ uid1: ['recipe-ai', 'econome'] }), 'uid1', 'econome')).resolves.toBeUndefined();
  });

  it.each([
    ['has other features only', { uid1: ['recipe-ai'] }],
    ['has no access record', {}],
  ])('stops an account that %s, naming the feature to add', async (_label, features) => {
    const denied = requireFeature(accessWith(features), 'uid1', 'econome');

    await expect(denied).rejects.toBeInstanceOf(AccessError);
    await expect(denied).rejects.toThrow(/"econome" feature/);
  });
});

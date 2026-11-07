import { describe, expect, it } from 'vitest';
import { DEFAULT_DAILY_CLAUDE_CAP_USD, SettingsSchema, toUpdatePaths, withDefaults } from './settings.ts';

describe('SettingsSchema', () => {
  it('accepts a complete set of settings', () => {
    const settings = {
      timezone: 'America/New_York',
      dailyClaudeCapUsd: 0.5,
      weeklyCapUsd: 150,
      hungryroot: { deliveryDay: 'monday', cutoffDay: 'thursday', cutoffTime: '19:00' },
    };

    expect(SettingsSchema.parse(settings)).toEqual(settings);
  });

  it.each([
    ['an unknown time zone', { timezone: 'Mars/Olympus' }],
    ['a cutoff time outside 24-hour HH:MM', { hungryroot: { cutoffTime: '7pm' } }],
    ['a misspelled weekday', { hungryroot: { deliveryDay: 'mondy' } }],
    ['a zero Claude cap', { dailyClaudeCapUsd: 0 }],
    ['a negative weekly cap', { weeklyCapUsd: -20 }],
  ])('rejects %s', (_label, settings) => {
    expect(SettingsSchema.safeParse(settings).success).toBe(false);
  });
});

describe('toUpdatePaths', () => {
  it('turns nested changes into dotted paths under the econome field, so sibling fields are kept', () => {
    expect(toUpdatePaths({ timezone: 'America/Chicago', hungryroot: { cutoffTime: '19:00' } })).toEqual({
      'econome.timezone': 'America/Chicago',
      'econome.hungryroot.cutoffTime': '19:00',
    });
  });

  it('never writes undefined values', () => {
    expect(toUpdatePaths({ timezone: undefined, hungryroot: { deliveryDay: undefined, cutoffDay: 'thursday' } })).toEqual(
      { 'econome.hungryroot.cutoffDay': 'thursday' },
    );
  });

  it('produces nothing for an empty change', () => {
    expect(toUpdatePaths({ hungryroot: {} })).toEqual({});
  });
});

describe('withDefaults', () => {
  it('fills in the default daily Claude cap', () => {
    expect(withDefaults({}).dailyClaudeCapUsd).toBe(DEFAULT_DAILY_CLAUDE_CAP_USD);
  });

  it('keeps a cap the household chose', () => {
    expect(withDefaults({ dailyClaudeCapUsd: 0.25 }).dailyClaudeCapUsd).toBe(0.25);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_CLAUDE_CAP_USD,
  DEFAULT_PLANNING_DIRECTIVE,
  SettingsSchema,
  toUpdatePaths,
  withDefaults,
} from '../../src/data/settings.ts';

describe('SettingsSchema', () => {
  it('accepts a complete set of settings', () => {
    const settings = {
      timezone: 'America/New_York',
      dailyClaudeCapUsd: 0.5,
      weeklyCapUsd: 150,
      hungryroot: {
        deliveryDay: 'monday',
        cutoffDay: 'thursday',
        cutoffTime: '19:00',
        planPriceUsd: 82.32,
        planCredits: 36,
        addOnCreditUsd: 1.99,
        boxServings: 12,
      },
      planningDirective: 'directives/cutting.md',
      mealTargets: { breakfast: 0, lunch: 8, dinner: 12 },
      kroger: { locationId: '01400513' },
    };

    expect(SettingsSchema.parse(settings)).toEqual(settings);
  });

  it.each([
    ['an unknown time zone', { timezone: 'Mars/Olympus' }],
    ['a cutoff time outside 24-hour HH:MM', { hungryroot: { cutoffTime: '7pm' } }],
    ['a misspelled weekday', { hungryroot: { deliveryDay: 'mondy' } }],
    ['a zero Claude cap', { dailyClaudeCapUsd: 0 }],
    ['a negative weekly cap', { weeklyCapUsd: -20 }],
    ['a planning directive outside directives/', { planningDirective: 'planning.md' }],
    ['a negative meal target', { mealTargets: { dinner: -2 } }],
    ['a fractional meal target', { mealTargets: { lunch: 2.5 } }],
    ['a box of part servings', { hungryroot: { boxServings: 12.5 } }],
    ['a Kroger store id of the wrong length', { kroger: { locationId: '123' } }],
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

  it('always has a planning directive, the general one unless the household chose another', () => {
    expect(withDefaults({}).planningDirective).toBe(DEFAULT_PLANNING_DIRECTIVE);
    expect(withDefaults({ planningDirective: 'directives/cutting.md' }).planningDirective).toBe('directives/cutting.md');
  });
});

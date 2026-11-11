import { reviewHash } from '../../src/core/product-check.ts';
import type { HouseholdRecord, Households } from '../../src/data/household.ts';
import { blankMemory, type RememberedProduct } from '../../src/data/product-memory.ts';
import type { RecipeDoc } from '../../src/data/recipes.ts';
import { createApp } from '../../src/http/app.ts';
import type { BrandedFood } from '../../src/sources/fdc.ts';
import type { RoutineTrigger } from '../../src/sources/routines.ts';
import {
  answeringClaude,
  entry,
  fakeFoodData,
  memoryDecisions,
  memoryIngredients,
  memoryJobs,
  memoryNotes,
  memoryParsedLines,
  memoryProductMemory,
  memoryVeganLine,
  memoryWeeks,
  parsedLine,
  parseOf,
} from '../fakes.ts';

export const SECRET = 'a-routine-secret-at-least-32-characters-long';
export const RESEARCH_ROUTINE: RoutineTrigger = { url: 'https://api.example.com/routines/research/fire', token: 'research-token' };

export const WEEK = '2026-W46';
export const DATE = '2026-11-10';

const tofu = { amount: 28, unit: 'oz', name: 'extra-firm tofu' };
const lemon = { amount: 1, unit: '', name: 'lemon' };
const salt = { amount: 1, unit: 'tsp', name: 'salt' };

const recipeDocs: RecipeDoc[] = [
  { id: 'r1', data: { title: 'Tofu Scramble', description: '', servings: 2, tags: [], ingredientGroups: [{ ingredients: [tofu, lemon, salt] }] } },
];

const home: HouseholdRecord = { id: 'h1', name: 'Home', members: ['uid1'], econome: { timezone: 'America/New_York', instacart: { retailer: 'Wegmans' } } };

const households: Households = {
  findUserHouseholdId: async (uid) => (uid === 'uid1' ? 'h1' : undefined),
  findHousehold: async (id) => (id === 'h1' ? home : undefined),
  findMemberProfiles: async (uids) => uids.map((uid) => ({ uid, name: `Member ${uid}` })),
  updateSettings: async () => undefined,
};

const tofuProduct = (): RememberedProduct[] => [
  { ...blankMemory('111', 'uid1', 'extra-firm tofu'), name: 'Organic Extra Firm Tofu', size: '14 oz', retailer: 'Wegmans', role: 'preferred' },
  {
    ...blankMemory('111', 'uid1'),
    name: 'Organic Extra Firm Tofu',
    size: '14 oz',
    retailer: 'Wegmans',
    vegan: { vegan: true, concerns: [], ingredientsHash: reviewHash(null), by: 'uid1' },
  },
];

export const setup = ({
  planned = true,
  researchRoutine = RESEARCH_ROUTINE,
  branded = {},
  moreRecipes = [],
  failingLabels = [],
}: {
  planned?: boolean;
  researchRoutine?: RoutineTrigger | null;
  branded?: Record<string, BrandedFood[]>;
  moreRecipes?: RecipeDoc[];
  failingLabels?: string[];
} = {}) => {
  let clock = new Date('2026-11-10T18:00:00.000Z');
  const fired: { trigger: RoutineTrigger; payload: unknown }[] = [];
  const jobs = memoryJobs();
  const weeks = memoryWeeks(planned ? { [WEEK]: { meals: [{ recipeId: 'r1', title: 'Tofu Scramble', servings: 2 }] } } : {});
  const ingredients = memoryIngredients([entry('extra-firm tofu', { buying: 'weekly' }), entry('salt', { buying: 'staple' })]);
  const products = memoryProductMemory(tofuProduct());
  const decisions = memoryDecisions();
  const { claude, prompts } = answeringClaude(() => {
    throw new Error('Claude should not be asked');
  });
  const app = createApp({
    verifier: { uidOf: async (token) => (token === 'token-1' ? 'uid1' : Promise.reject(new Error('bad token'))) },
    access: { featuresOf: async () => ['econome'] },
    households,
    spend: { spentOn: async () => 0 },
    weeks: weeks.store,
    recipes: { listRecipeDocs: async () => [...recipeDocs, ...moreRecipes] },
    parsedLines: memoryParsedLines([
      parsedLine(tofu, parseOf('extra-firm tofu', { amount: 28, unit: 'oz' }), 'claude', ['r1']),
      parsedLine(lemon, parseOf('lemon'), 'claude', ['r1']),
      parsedLine(salt, parseOf('salt', { unit: 'tsp' }), 'claude', ['r1']),
    ]).store,
    ingredients: ingredients.store,
    notes: memoryNotes().store,
    claude,
    fdc: fakeFoodData({}, branded, failingLabels).foodData,
    productMemory: products.store,
    veganLine: memoryVeganLine().store,
    decisions: decisions.store,
    jobs: jobs.store,
    routines: {
      fire: async (trigger, payload) => {
        fired.push({ trigger, payload });
        return { sessionId: `cse_${fired.length}`, sessionUrl: `https://claude.example.com/code/cse_${fired.length}` };
      },
    },
    fillRoutine: null,
    researchRoutine,
    routineSecret: SECRET,
    allowedOrigins: [],
    now: () => clock,
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`/api${path}`, {
      method,
      headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const report = async (body: unknown, secret = SECRET) => {
    const response = await app.request('/routines/instacart-research/result', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const advance = (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60 * 1000);
  };
  return { call, report, advance, fired, jobs, weeks, ingredients, products, decisions, prompts };
};

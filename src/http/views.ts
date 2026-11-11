import type { CalendarWeek } from '../core/calendar.ts';
import { compareCart, listHash, type MatchedItem } from '../core/instacart-match.ts';
import type { ListItem } from '../core/shopping-list.ts';
import type { Household } from '../data/household.ts';
import { idsOf, type IngredientEntry } from '../data/ingredients.ts';
import { jobError, jobState, type Finds, type Job } from '../data/jobs.ts';
import { MEAL_SLOTS, weekCoverage, type InstacartSection, type PlannedWeek } from '../data/weeks.ts';
import type { WeekList } from '../services/week-list.ts';

export const weekRef = ({ id, start, end }: CalendarWeek) => ({ id, start, end });

const needOf = ({ need, amount, buy }: ListItem) => ({
  text: need ?? 'as needed',
  ...(amount && { amount: amount.value, unit: amount.unit }),
  ...(buy && { buy }),
});

export const shopState = ({ meals, instacart }: Pick<PlannedWeek, 'meals' | 'instacart'>) => {
  const { approved, sent, filled, checkedOut } = instacart;
  if (meals.length === 0) return 'not-saved';
  if (checkedOut) return 'checked-out';
  if (!approved) return 'list';
  if (sent?.error) return 'failed';
  if (filled) return compareCart(approved.lines, filled.lines).matches ? 'filled' : 'differences';
  if (sent) return 'filling';
  return 'approved';
};

export const weekView = (planned: PlannedWeek, household: Household) => {
  const targets = { ...household.settings.mealTargets, ...planned.targets };
  const coverage = weekCoverage(planned, household.members.length, targets);
  const hasTargets = Object.keys(targets).length > 0;
  return {
    week: weekRef(planned.week),
    saved: planned.meals.length > 0,
    meals: planned.meals.map(({ recipeId, title, servings, slot = 'dinner' }) => ({ recipeId, title, servings, slot, extra: hasTargets && !targets[slot] })),
    coverage: Object.fromEntries(
      MEAL_SLOTS.map((slot) => [
        slot,
        { planned: coverage[slot].planned, target: targets[slot] ?? 0, ...(slot === 'lunch' && { fromLeftovers: coverage.lunch.fromLeftovers }) },
      ]),
    ),
    hungryroot: {
      state: planned.hungryroot.length === 0 ? 'open' : planned.boxLocked ? 'locked' : 'confirmed',
      recipes: planned.hungryroot.map(({ title, servings }) => ({ title, servings })),
    },
    review: { offer: false },
    shop: { state: shopState(planned) },
  };
};

export const listView = ({ week, list, warnings, entries }: WeekList, match: (item: ListItem) => MatchedItem) => {
  const idOf = idsOf(entries);
  return {
    week: weekRef(week),
    listHash: listHash(list.buy),
    buy: list.buy.map((item) => {
      const { pick } = match(item);
      const before = match({ ...item, onHand: undefined }).pick?.packages;
      return {
        ingredientId: idOf(item.ingredient),
        ingredient: item.ingredient,
        need: needOf(item),
        firstTime: Boolean(item.firstTime),
        runningLow: Boolean(item.runningLow),
        optional: Boolean(item.optional),
        someAllowed: Boolean(item.onHand) || (item.amount !== undefined && (before ?? item.amount.value) > 1),
        have: item.onHand ? { state: 'some', ...item.onHand } : { state: 'none' },
        ...(pick && { pack: { product: pick.name, size: pick.size, toBuy: pick.packages } }),
        uses: item.uses,
      };
    }),
    have: list.have.map((item) => ({
      ingredientId: idOf(item.ingredient),
      ingredient: item.ingredient,
      need: needOf(item),
      have: item.onHand ? { state: 'some', ...item.onHand } : { state: 'all' },
    })),
    staples: list.probablyHave.map((item) => ({ ingredientId: idOf(item.ingredient), ingredient: item.ingredient, thisWeek: item.need ?? 'as needed', out: false })),
    notBought: list.notBought.map((item) => ({ ingredientId: idOf(item.ingredient), ingredient: item.ingredient, need: needOf(item), ...(item.comesWith && { comesWith: item.comesWith }) })),
    warnings,
  };
};

const jobResult = (job: Job) => {
  if (job.kind === 'search') {
    const [searched] = job.items.map(({ ingredientId, ingredient }) => ({
      ingredientId,
      ingredient,
      suggestions: job.found[ingredientId]?.suggestions ?? [],
      excluded: job.found[ingredientId]?.excluded ?? [],
    }));
    return searched ?? { suggestions: [], excluded: [] };
  }
  const named = ({ ingredientId, ingredient }: Job['items'][number]) => ({ ingredientId, ingredient });
  return {
    found: job.items.filter(({ ingredientId }) => (job.found[ingredientId]?.suggestions.length ?? 0) > 0).length,
    of: job.items.length,
    nothingFor: job.items.filter(({ ingredientId }) => job.found[ingredientId]?.suggestions.length === 0).map(named),
    notSearched: job.items.filter(({ ingredientId }) => !job.found[ingredientId]).map(named),
  };
};

export const jobView = (job: Job, now: Date) => {
  const state = jobState(job, now);
  const error = jobError(job, now);
  return {
    id: job.id,
    kind: job.kind,
    state,
    week: job.week.id,
    progress: { done: job.items.filter(({ ingredientId }) => job.found[ingredientId]).length, total: job.items.length },
    startedAt: job.startedAt,
    ...(state !== 'running' && { result: jobResult(job) }),
    ...(error && { error }),
  };
};

const productStatus = ({ pick }: MatchedItem, lookingUp: boolean) => {
  if (pick?.vegan.verdict === 'non-vegan') return 'not-vegan';
  if (pick) return pick.vegan.verdict === 'needs-review' ? 'vegan-question' : 'ready';
  return lookingUp ? 'looking-up' : 'choose';
};

const productOf = ({ productId, name, size, packages, vegan }: NonNullable<MatchedItem['pick']>) => ({ productId, name, size, packages, vegan });

export const productsView = (
  { week, buy, items, entries }: { week: CalendarWeek; buy: ListItem[]; items: MatchedItem[]; entries: IngredientEntry[] },
  retailer: string,
  finds: Finds,
  now: Date,
) => {
  const idOf = idsOf(entries);
  const searchOf = new Map(entries.map(({ name, storeSearch }) => [name, storeSearch]));
  const shown = items.map((item, index) => {
    const id = idOf(item.ingredient);
    const found = finds.found.get(id);
    const status = productStatus(item, finds.pending.has(id));
    const listed = buy[index];
    const picked = item.pick?.productId;
    const alternates = item.alternates.filter(({ productId }) => productId !== picked).map((alternate) => ({ ...productOf(alternate), why: ['your alternate'] }));
    const known = new Set([picked, ...alternates.map(({ productId }) => productId)]);
    const offered = status !== 'looking-up';
    return {
      ingredientId: id,
      ingredient: item.ingredient,
      need: listed ? needOf(listed) : { text: item.need ?? 'as needed' },
      status,
      ...(item.pick && { pick: productOf(item.pick) }),
      ...(offered && { suggestions: [...alternates, ...(found?.suggestions ?? []).filter(({ productId }) => !known.has(productId))] }),
      ...(offered && found && found.excluded.length > 0 && { excluded: found.excluded }),
      search: item.search ?? searchOf.get(item.ingredient) ?? item.ingredient,
    };
  });
  const counted = (status: string) => shown.filter((shownItem) => shownItem.status === status).length;
  return {
    week: weekRef(week),
    retailer,
    listHash: listHash(buy),
    lookup: finds.lookup && jobView(finds.lookup, now),
    blockers: { toChoose: counted('choose'), lookingUp: counted('looking-up'), veganQuestions: counted('vegan-question'), notVegan: counted('not-vegan') },
    items: shown,
  };
};

export const cartView = (planned: Pick<PlannedWeek, 'week' | 'meals' | 'instacart'>, currentListHash: string | null) => {
  const { approved, sent, filled, checkedOut }: InstacartSection = planned.instacart;
  const fillState = !sent ? null : sent.error ? 'failed' : filled?.fillId === sent.fillId ? 'done' : 'running';
  return {
    week: weekRef(planned.week),
    state: shopState(planned),
    approved: approved && { lines: approved.lines.length },
    fill: sent && { state: fillState, run: sent.sessionId, error: sent.error },
    comparison: approved && filled ? compareCart(approved.lines, filled.lines) : null,
    listChanged: Boolean(approved && currentListHash && currentListHash !== approved.listHash),
    checkedOut: Boolean(checkedOut),
  };
};

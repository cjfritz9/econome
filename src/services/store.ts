import { chooseWeek } from '../core/calendar.ts';
import { cartLines, compareCart, connectorItems, listHash, matchItem } from '../core/instacart-match.ts';
import { bestLabel, checkProduct, labelQuery, reviewHash } from '../core/product-check.ts';
import type { ListItem } from '../core/shopping-list.ts';
import { concernsToCount } from '../core/vegan.ts';
import type { Decisions } from '../data/decisions.ts';
import type { Household } from '../data/household.ts';
import { withStoreSearch, type IngredientRegistry } from '../data/ingredients.ts';
import {
  blankMemory,
  forIngredient,
  productRecord,
  rememberedId,
  reviewOf,
  type ProductMemory,
  type RememberedProduct,
  type VeganLine,
} from '../data/product-memory.ts';
import type { ParsedLines } from '../data/parsed-lines.ts';
import { loadWeeks, type InCart, type Weeks } from '../data/weeks.ts';
import type { FoodData } from '../sources/fdc.ts';
import { logger } from '../logger.ts';
import { NotFoundError, RefusedError } from './errors.ts';

const LABEL_PARALLEL = 3;
const SAVE_PARALLEL = 3;

const UNANSWERED = {
  verdict: 'needs-review' as const,
  reasons: ["FoodData Central didn't answer, so its ingredients aren't checked yet"],
  source: 'no ingredient list' as const,
  label: null,
};

export interface StoreDeps {
  fdc: FoodData;
  productMemory: ProductMemory;
  veganLine: VeganLine;
  ingredients: IngredientRegistry;
  parsedLines: ParsedLines;
  decisions: Decisions;
  weeks: Weeks;
  buyList: (household: Household, date: string | undefined) => Promise<{ week: string; buy: ListItem[] }>;
}

export interface Choice {
  ingredient: string;
  productId: string;
  name: string;
  size?: string;
  as?: 'preferred' | 'alternate';
  covers?: number;
}

export interface VeganAnswer {
  productId: string;
  name: string;
  vegan: boolean;
  note?: string;
}

export interface FailedChange {
  ingredientId?: string;
  productId: string;
  error: string;
}

const failureOf = (error: unknown) => {
  if (error instanceof RefusedError || error instanceof NotFoundError) return error.message;
  logger.error({ err: error }, 'A product change in a batch failed');
  return "Économe couldn't save this one just now. Try it again.";
};

const inBatches = async <T, R>(items: T[], size: number, run: (item: T) => Promise<R>) => {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) results.push(...(await Promise.all(items.slice(start, start + size).map(run))));
  return results;
};

export const retailerOf = (household: Household) => {
  const retailer = household.settings.instacart?.retailer;
  if (!retailer) throw new RefusedError("The household's Instacart store isn't set yet; save it with update_settings as instacart.retailer, such as Wegmans.");
  return retailer;
};

export const storeService = ({ fdc, productMemory, veganLine, ingredients, parsedLines, decisions, weeks, buyList }: StoreDeps, by: string) => {
  const labelFor = async (name: string) => bestLabel(name, await fdc.branded(labelQuery(name)));

  const knownIngredient = async (householdId: string, ingredient: string) => {
    const [entries, lines] = await Promise.all([ingredients.list(householdId), parsedLines.list(householdId)]);
    const entry = entries.find(({ name }) => name === ingredient);
    if (!entry && !lines.some(({ parse }) => parse.ingredient === ingredient)) throw new NotFoundError(`"${ingredient}" isn't a known ingredient. Use the name build_list or list_ingredients shows.`);
    return { entries, entry };
  };

  const recordFor = (memory: RememberedProduct[], productId: string, ingredient: string | null) =>
    memory.find(({ id }) => id === rememberedId('instacart', productId, ingredient)) ?? blankMemory(productId, by, ingredient);

  const matchWeek = async (household: Household, date: string | undefined) => {
    const [{ week, buy }, memory, entries] = await Promise.all([buyList(household, date), productMemory.list(household.id), ingredients.list(household.id)]);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    return { week, buy, entries, items: buy.map((item) => matchItem(item, memory, byName.get(item.ingredient))) };
  };

  const checkProducts = async (householdId: string, products: { productId: string; name: string }[]) => {
    const [memory, tallies] = await Promise.all([productMemory.list(householdId), veganLine.tallies(householdId)]);
    return inBatches(products, LABEL_PARALLEL, async ({ productId, name }) => {
      const label = await labelFor(name).catch((error: unknown) => {
        logger.warn({ err: error, productId }, 'Could not read an ingredient list from FoodData Central');
        return undefined;
      });
      if (label === undefined) return { productId, name, ...UNANSWERED };
      return { productId, name, ...checkProduct(name, label, tallies, reviewOf(memory, productId)) };
    });
  };

  const veganDetail = async (household: Household, productId: string) => {
    const [memory, tallies] = await Promise.all([productMemory.list(household.id), veganLine.tallies(household.id)]);
    const record = productRecord(memory, productId);
    if (!record?.name) throw new NotFoundError(`Économe doesn't know product ${productId} yet; choose it for an ingredient first.`);
    const label = await labelFor(record.name);
    const check = checkProduct(record.name, label, tallies, reviewOf(memory, productId));
    const concerns = concernsToCount(checkProduct(record.name, label, tallies));
    return {
      productId,
      name: record.name,
      verdict: check.verdict,
      reasons: check.reasons,
      label: label && { description: check.label, ingredients: label.ingredients },
      history: concerns.map((concern) => ({ concern, vegan: tallies.get(concern)?.ok ?? 0, notVegan: tallies.get(concern)?.notOk ?? 0 })),
    };
  };

  const chooseProduct = async (household: Household, { ingredient, productId, name, size, as = 'preferred', covers }: Choice) => {
    const retailer = retailerOf(household);
    await knownIngredient(household.id, ingredient);
    const [memory, tallies, label] = await Promise.all([productMemory.list(household.id), veganLine.tallies(household.id), labelFor(name)]);
    const vegan = checkProduct(name, label, tallies, reviewOf(memory, productId));
    if (vegan.verdict === 'non-vegan') {
      throw new RefusedError(`${name} looks non-vegan (${vegan.reasons.join('; ')}). If that's wrong, answer its vegan question first.`);
    }
    const details = { name, size: size ?? null, retailer };
    const chosen = { ...recordFor(memory, productId, ingredient), ...details, role: as, reason: null, ...(covers && { covers }), decidedBy: by };
    const product = { ...recordFor(memory, productId, null), ...details, check: { verdict: vegan.verdict, reasons: vegan.reasons, label: vegan.label } };
    const demoted =
      as === 'preferred'
        ? forIngredient(memory, ingredient, 'preferred')
            .filter((other) => other.productId !== productId)
            .map((other) => ({ ...other, role: 'alternate' as const }))
        : [];
    await productMemory.save(household.id, [chosen, product, ...demoted]);
    await decisions.record(household.id, {
      kind: 'product-choice',
      input: { ingredient, store: 'instacart', retailer },
      suggestion: demoted.map((other) => other.productId),
      answer: { productId, name, size: size ?? null, role: as, covers: covers ?? null },
      by,
    });
    return {
      ingredient,
      chosen: { productId, name, size: size ?? null },
      as,
      vegan,
      ...(demoted.length > 0 && { nowAlternates: demoted.map((other) => other.name ?? other.productId) }),
    };
  };

  const rejectProduct = async (household: Household, { ingredient, productId, name, reason }: { ingredient: string; productId: string; name?: string; reason?: string }) => {
    await knownIngredient(household.id, ingredient);
    const memory = await productMemory.list(household.id);
    const current = recordFor(memory, productId, ingredient);
    await productMemory.save(household.id, [{ ...current, ...(name && { name }), role: 'rejected', reason: reason ?? null, decidedBy: by }]);
    await decisions.record(household.id, {
      kind: 'product-choice',
      input: { ingredient, store: 'instacart' },
      suggestion: productId,
      answer: { productId, name: name ?? null, role: 'rejected', reason: reason ?? null },
      by,
    });
    return { ingredient, rejected: name ?? productId, ...(reason && { reason }) };
  };

  const setStoreSearch = async (household: Household, ingredient: string, term: string) => {
    const { entries, entry } = await knownIngredient(household.id, ingredient);
    const saved = withStoreSearch(entries, ingredient, term);
    await ingredients.save(household.id, [saved]);
    await decisions.record(household.id, { kind: 'store-search', input: ingredient, suggestion: entry?.storeSearch ?? ingredient, answer: saved.storeSearch, by });
    return { ingredient, storeSearchAs: saved.storeSearch };
  };

  const reviewVegan = async (household: Household, { productId, name, vegan, note }: VeganAnswer) => {
    const [memory, tallies, label] = await Promise.all([productMemory.list(household.id), veganLine.tallies(household.id), labelFor(name)]);
    const before = checkProduct(name, label, tallies);
    const concerns = concernsToCount(before);
    const product = recordFor(memory, productId, null);
    await productMemory.save(household.id, [
      {
        ...product,
        name,
        vegan: { vegan, concerns, ingredientsHash: reviewHash(label), by },
        check: { verdict: before.verdict, reasons: before.reasons, label: before.label },
      },
    ]);
    if (concerns.length > 0) await veganLine.count(household.id, concerns, vegan);
    await decisions.record(household.id, {
      kind: 'vegan-review',
      input: { productId, store: 'instacart', name, ingredients: label?.ingredients ?? null, concerns },
      suggestion: { verdict: before.verdict, reasons: before.reasons },
      answer: { vegan, note: note ?? null },
      by,
    });
    return { product: name, vegan, wasJudged: before, ...(concerns.length > 0 && { counted: concerns }) };
  };

  const weekSection = async (household: Household, date: string | undefined) => {
    const week = chooseWeek(household.settings.timezone, date);
    const [planned] = await loadWeeks(weeks, household.id, [week]);
    if (!planned) throw new NotFoundError(`Nothing is planned for ${week.id}.`);
    return { week, section: planned.instacart };
  };

  const approve = async (household: Household, date: string | undefined, quantities?: Record<string, number>) => {
    const retailer = retailerOf(household);
    const { week } = await weekSection(household, date);
    const { buy, items } = await matchWeek(household, date);
    const { lines, notInCart, needQuantity } = cartLines(items, quantities);
    if (needQuantity.length > 0) throw new RefusedError(`Say how many to buy of: ${needQuantity.join(', ')}, then approve again.`);
    const unsettled = items.filter(({ pick }) => pick && pick.vegan.verdict !== 'vegan');
    if (unsettled.length > 0) {
      const named = unsettled.map(({ ingredient, pick }) => `${ingredient} (${pick?.name ?? pick?.productId}: ${pick?.vegan.verdict})`);
      throw new RefusedError(`Settle these products' vegan checks first: ${named.join('; ')}.`);
    }
    await weeks.saveInstacart(household.id, week.id, {
      retailer,
      approved: { lines, listHash: listHash(buy), by },
      sent: null,
      filled: null,
      checkedOut: null,
    });
    return { week: week.id, retailer, lines, notInCart, connector: { retailer_name: retailer, item_updates: connectorItems(lines) } };
  };

  const recordCart = async (household: Household, date: string | undefined, items: InCart[]) => {
    const { week, section } = await weekSection(household, date);
    if (!section.approved) throw new RefusedError(`${week.id}'s Instacart cart isn't approved yet; approve it first.`);
    await weeks.saveInstacart(household.id, week.id, { ...section, filled: { by, lines: items, fillId: null } });
    const { buy } = await buyList(household, date);
    return {
      week: week.id,
      ...compareCart(section.approved.lines, items),
      ...(listHash(buy) !== section.approved.listHash && { listChanged: 'The shopping list changed since approval; match and approve again.' }),
    };
  };

  const markCheckedOut = async (household: Household, date: string | undefined) => {
    const { week, section } = await weekSection(household, date);
    await weeks.saveInstacart(household.id, week.id, { ...section, checkedOut: { by } });
    return { week: week.id, checkedOut: true };
  };

  const saveMany = async (household: Household, veganAnswers: VeganAnswer[], choices: (Choice & { ingredientId?: string })[]): Promise<FailedChange[]> => {
    const reviewed = await inBatches(veganAnswers, SAVE_PARALLEL, async (answer) =>
      reviewVegan(household, answer).then(
        () => null,
        (error: unknown) => ({ productId: answer.productId, error: failureOf(error) }),
      ),
    );
    const chosen = await inBatches(choices, SAVE_PARALLEL, async ({ ingredientId, ...choice }) =>
      chooseProduct(household, choice).then(
        () => null,
        (error: unknown) => ({ ...(ingredientId && { ingredientId }), productId: choice.productId, error: failureOf(error) }),
      ),
    );
    return [...reviewed, ...chosen].filter((failed) => failed !== null);
  };

  return {
    matchWeek,
    checkProducts,
    veganDetail,
    chooseProduct,
    rejectProduct,
    setStoreSearch,
    reviewVegan,
    saveMany,
    weekSection,
    approve,
    recordCart,
    markCheckedOut,
  };
};

export type StoreService = ReturnType<typeof storeService>;

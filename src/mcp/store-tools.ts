import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { chooseWeek } from '../core/calendar.ts';
import { cartLines, compareCart, listHash, matchItem } from '../core/instacart-match.ts';
import { bestLabel, checkProduct, labelQuery, reviewHash } from '../core/product-check.ts';
import type { ListItem } from '../core/shopping-list.ts';
import { concernsToCount } from '../core/vegan.ts';
import type { Decisions } from '../data/decisions.ts';
import type { Household } from '../data/household.ts';
import { withStoreSearch, type IngredientRegistry } from '../data/ingredients.ts';
import {
  blankMemory,
  forIngredient,
  rememberedId,
  reviewOf,
  type ProductMemory,
  type RememberedProduct,
  type VeganLine,
} from '../data/product-memory.ts';
import { loadWeeks, type CartLine, type Weeks } from '../data/weeks.ts';
import type { FoodData } from '../sources/fdc.ts';
import { inBatches, jsonResult, WeekDate } from './shared.ts';

const LABEL_PARALLEL = 3;
const MAX_CHECKED = 20;

interface StoreToolDeps {
  member: () => Promise<Household>;
  fdc: FoodData;
  productMemory: ProductMemory;
  veganLine: VeganLine;
  ingredients: IngredientRegistry;
  decisions: Decisions;
  actingUid: string;
  buyList: (household: Household, date: string | undefined) => Promise<{ week: string; buy: ListItem[] }>;
  weeks: Weeks;
}

const ProductId = z.string().regex(/^\d+$/, "An Instacart product_id, as the Instacart connector's search shows it");
const ProductName = z.string().min(1).describe("The product's name exactly as the Instacart connector shows it, brand included");
const Ingredient = z.string().min(1).describe('The ingredient as build_list or list_ingredients shows it');

const connectorItems = (lines: CartLine[]) => {
  const totals = new Map<string, number>();
  for (const { productId, quantity } of lines) totals.set(productId, (totals.get(productId) ?? 0) + quantity);
  return [...totals].map(([productId, quantity]) => ({ product_id: productId, quantity }));
};

export const registerStoreTools = (
  server: McpServer,
  { member, fdc, productMemory, veganLine, ingredients, decisions, actingUid, buyList, weeks }: StoreToolDeps,
) => {
  const retailerOf = (household: Household) => {
    const retailer = household.settings.instacart?.retailer;
    if (!retailer) throw new Error("The household's Instacart store isn't set yet; save it with update_settings as instacart.retailer, such as Wegmans.");
    return retailer;
  };

  const knownIngredient = async (householdId: string, ingredient: string) => {
    const entries = await ingredients.list(householdId);
    const entry = entries.find(({ name }) => name === ingredient);
    if (!entry) throw new Error(`"${ingredient}" isn't a known ingredient. Use the name build_list or list_ingredients shows.`);
    return { entries, entry };
  };

  const labelFor = async (name: string) => bestLabel(name, await fdc.branded(labelQuery(name)));

  const matchWeek = async (household: Household, date: string | undefined) => {
    const [{ week, buy }, memory, entries] = await Promise.all([buyList(household, date), productMemory.list(household.id), ingredients.list(household.id)]);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    return { week, buy, items: buy.map((item) => matchItem(item, memory, byName.get(item.ingredient))) };
  };

  const recordFor = (memory: RememberedProduct[], productId: string, ingredient: string | null) =>
    memory.find(({ id }) => id === rememberedId('instacart', productId, ingredient)) ?? blankMemory(productId, actingUid, ingredient);

  server.registerTool(
    'match_instacart',
    {
      description:
        "Match a week's buy list to the household's Instacart store (settings.instacart.retailer). Each item uses the product the household chose for it, by Instacart product_id, with its name, size, vegan verdict and how many packages cover the need, and lists its alternates. An item without one has a search term: search the store for it with the Instacart connector's search_products (never its quick-add, which adds the first result), propose a product that follows the household's brand notes and passes check_vegan, and record the household's pick with choose_product. Products under rejected were turned down for that item; don't offer them.",
      inputSchema: z.object({ week: WeekDate }),
    },
    async ({ week: date }) => {
      const household = await member();
      const retailer = retailerOf(household);
      const { week, items } = await matchWeek(household, date);
      return jsonResult({
        week,
        retailer,
        chosen: items.filter(({ status }) => status === 'chosen').length,
        toChoose: items.filter(({ status }) => status === 'choose').map(({ ingredient }) => ingredient),
        items,
      });
    },
  );

  server.registerTool(
    'check_vegan',
    {
      description:
        "Check Instacart products for vegan before proposing them. Instacart gives no ingredients, so each product is looked up in USDA FoodData Central's branded foods by brand and name, its ingredient list goes through Économe's vegan check (and the household's past answers), and its name is screened too. A household review of the product overrides all of it. When no list is found and the product is a single whole food (fresh produce, fresh herbs, plain beans), you may judge it vegan yourself and record that with review_vegan, noting it's your judgement; anything else goes to the household.",
      inputSchema: z.object({
        products: z.array(z.object({ productId: ProductId, name: ProductName })).min(1).max(MAX_CHECKED),
      }),
    },
    async ({ products }) => {
      const household = await member();
      const [memory, tallies] = await Promise.all([productMemory.list(household.id), veganLine.tallies(household.id)]);
      return jsonResult(
        await inBatches(products, LABEL_PARALLEL, async ({ productId, name }) => {
          const check = checkProduct(name, await labelFor(name), tallies, reviewOf(memory, productId));
          return { productId, name, ...check };
        }),
      );
    },
  );

  server.registerTool(
    'choose_product',
    {
      description:
        "Record the Instacart product the household buys for an ingredient: as its usual product, or as an alternate. Give the product_id, name and size exactly as the Instacart connector shows them; Économe keeps them, since it can't look products up itself, and uses them from then on to count packages. The product is checked for vegan first, and one that looks non-vegan can't be chosen until the household reviews it with review_vegan. Saved as a decision.",
      inputSchema: z.object({
        ingredient: Ingredient,
        productId: ProductId,
        name: ProductName,
        size: z.string().min(1).optional().describe("The product's size as the connector shows it, such as 14 oz or 3 ct"),
        as: z.enum(['preferred', 'alternate']).optional().describe('preferred (the usual product) if left out'),
        covers: z
          .number()
          .positive()
          .optional()
          .describe("How much one package covers, in the list's unit for this ingredient, when the size doesn't say, such as 7 for a bunch of green onions"),
      }),
    },
    async ({ ingredient, productId, name, size, as = 'preferred', covers }) => {
      const household = await member();
      const retailer = retailerOf(household);
      await knownIngredient(household.id, ingredient);
      const [memory, tallies, label] = await Promise.all([productMemory.list(household.id), veganLine.tallies(household.id), labelFor(name)]);
      const vegan = checkProduct(name, label, tallies, reviewOf(memory, productId));
      if (vegan.verdict === 'non-vegan') {
        throw new Error(`${name} looks non-vegan (${vegan.reasons.join('; ')}). If that's wrong, review it with review_vegan first.`);
      }
      const details = { name, size: size ?? null, retailer };
      const chosen = { ...recordFor(memory, productId, ingredient), ...details, role: as, reason: null, ...(covers && { covers }), decidedBy: actingUid };
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
        by: actingUid,
      });
      return jsonResult({
        ingredient,
        chosen: { productId, name, size: size ?? null },
        as,
        vegan,
        ...(demoted.length > 0 && { nowAlternates: demoted.map((other) => other.name ?? other.productId) }),
      });
    },
  );

  server.registerTool(
    'reject_product',
    {
      description:
        'Record that an Instacart product is wrong for an ingredient, such as canned green beans when the recipes want fresh, so match_instacart lists it under rejected and it is never offered for that ingredient again. Saved as a decision; choose_product can bring it back.',
      inputSchema: z.object({ ingredient: Ingredient, productId: ProductId, name: ProductName.optional(), reason: z.string().min(1).optional() }),
    },
    async ({ ingredient, productId, name, reason }) => {
      const household = await member();
      await knownIngredient(household.id, ingredient);
      const memory = await productMemory.list(household.id);
      const current = recordFor(memory, productId, ingredient);
      await productMemory.save(household.id, [
        { ...current, ...(name && { name }), role: 'rejected', reason: reason ?? null, decidedBy: actingUid },
      ]);
      await decisions.record(household.id, {
        kind: 'product-choice',
        input: { ingredient, store: 'instacart' },
        suggestion: productId,
        answer: { productId, name: name ?? null, role: 'rejected', reason: reason ?? null },
        by: actingUid,
      });
      return jsonResult({ ingredient, rejected: name ?? productId, ...(reason && { reason }) });
    },
  );

  server.registerTool(
    'set_store_search',
    {
      description:
        'Teach Économe what to search the Instacart store for when an ingredient\'s own name finds the wrong products, such as "fresh green beans" for green beans. match_instacart gives it as the search term from then on. Saved as a decision.',
      inputSchema: z.object({ ingredient: Ingredient, term: z.string().min(3).describe('What to search the store for') }),
    },
    async ({ ingredient, term }) => {
      const household = await member();
      const { entries, entry } = await knownIngredient(household.id, ingredient);
      const saved = withStoreSearch(entries, ingredient, term);
      await ingredients.save(household.id, [saved]);
      await decisions.record(household.id, {
        kind: 'store-search',
        input: ingredient,
        suggestion: entry.storeSearch ?? ingredient,
        answer: saved.storeSearch,
        by: actingUid,
      });
      return jsonResult({ ingredient, storeSearchAs: saved.storeSearch });
    },
  );

  server.registerTool(
    'review_vegan',
    {
      description:
        "Answer a vegan flag on an Instacart product: vegan or not, as the household judges it (or as you judged a single whole food with no ingredient list, saying so in the note). The answer sticks to the product until its ingredient list in FoodData Central changes, and teaches Économe the household's line: once a concern (natural flavors, sugar and the like) has three answers the same way and none the other way, it's decided automatically. A product named or listed with a meat is always asked about. Saved as a decision.",
      inputSchema: z.object({ productId: ProductId, name: ProductName, vegan: z.boolean(), note: z.string().min(1).optional() }),
    },
    async ({ productId, name, vegan, note }) => {
      const household = await member();
      const [memory, tallies, label] = await Promise.all([productMemory.list(household.id), veganLine.tallies(household.id), labelFor(name)]);
      const before = checkProduct(name, label, tallies);
      const concerns = concernsToCount(before);
      const product = recordFor(memory, productId, null);
      await productMemory.save(household.id, [
        {
          ...product,
          name,
          vegan: { vegan, concerns, ingredientsHash: reviewHash(label), by: actingUid },
          check: { verdict: before.verdict, reasons: before.reasons, label: before.label },
        },
      ]);
      if (concerns.length > 0) await veganLine.count(household.id, concerns, vegan);
      await decisions.record(household.id, {
        kind: 'vegan-review',
        input: { productId, store: 'instacart', name, ingredients: label?.ingredients ?? null, concerns },
        suggestion: { verdict: before.verdict, reasons: before.reasons },
        answer: { vegan, note: note ?? null },
        by: actingUid,
      });
      return jsonResult({ product: name, vegan, wasJudged: before, ...(concerns.length > 0 && { counted: concerns }) });
    },
  );

  const weekSection = async (household: Household, date: string | undefined) => {
    const week = chooseWeek(household.settings.timezone, date);
    const [planned] = await loadWeeks(weeks, household.id, [week]);
    if (!planned) throw new Error(`Nothing is planned for ${week.id}.`);
    return { week, section: planned.instacart };
  };

  server.registerTool(
    'approve_instacart',
    {
      description:
        "Approve the week's Instacart cart on the household's yes: every item matched to a product the household chose, with its package count. Items without a chosen product stay out and are listed; every product must be judged vegan first. Returns the lines to show, and connector.item_updates ready for the Instacart connector's cart tool at the household's store (quantities are set, not added, and lines sharing a product are already combined). After adding them, read the cart back and pass its items to record_instacart_cart. If the shopping list changes later, approve again.",
      inputSchema: z.object({
        week: WeekDate,
        quantities: z
          .record(z.string(), z.number().int().positive())
          .optional()
          .describe("Packages to buy by ingredient, where match_instacart couldn't count them or the household wants a different number"),
      }),
    },
    async ({ week: date, quantities }) => {
      const household = await member();
      const retailer = retailerOf(household);
      const { week } = await weekSection(household, date);
      const { items } = await matchWeek(household, date);
      const { lines, notInCart, needQuantity } = cartLines(items, quantities);
      if (needQuantity.length > 0) throw new Error(`Say how many to buy of: ${needQuantity.join(', ')} (pass them in quantities), then approve again.`);
      const unsettled = items.filter(({ pick }) => pick && pick.vegan.verdict !== 'vegan');
      if (unsettled.length > 0) {
        const named = unsettled.map(({ ingredient, pick }) => `${ingredient} (${pick?.name ?? pick?.productId}: ${pick?.vegan.verdict})`);
        throw new Error(`Settle these products' vegan checks with check_vegan or review_vegan first: ${named.join('; ')}.`);
      }
      await weeks.saveInstacart(household.id, week.id, {
        retailer,
        approved: { lines, listHash: listHash(items), by: actingUid },
        filled: null,
        checkedOut: null,
      });
      return jsonResult({
        week: week.id,
        retailer,
        lines: lines.map(({ ingredient, name, productId, quantity }) => ({ ingredient, product: name ?? productId, quantity })),
        connector: { retailer_name: retailer, item_updates: connectorItems(lines) },
        ...(notInCart.length > 0 && { notInCart }),
        then: 'Add these with the Instacart connector, read the cart back, and pass its items to record_instacart_cart.',
      });
    },
  );

  server.registerTool(
    'record_instacart_cart',
    {
      description:
        "Record what's actually in the household's Instacart cart, as the connector's cart tool shows it after filling, and compare it with the approved lines: what's missing, what has a different quantity, and anything extra. Report every difference to the household.",
      inputSchema: z.object({
        week: WeekDate,
        items: z
          .array(z.object({ productId: ProductId, quantity: z.number().positive(), name: z.string().min(1).optional() }))
          .describe('Every item in the cart, with its product_id and quantity as the connector shows them'),
      }),
    },
    async ({ week: date, items }) => {
      const household = await member();
      const { week, section } = await weekSection(household, date);
      if (!section.approved) throw new Error(`${week.id}'s Instacart cart isn't approved yet; approve it with approve_instacart.`);
      const lines = items.map(({ productId, quantity, name }) => ({ productId, quantity, name: name ?? null }));
      await weeks.saveInstacart(household.id, week.id, { ...section, filled: { by: actingUid, lines } });
      const { buy } = await buyList(household, date);
      return jsonResult({
        week: week.id,
        ...compareCart(section.approved.lines, lines),
        ...(listHash(buy) !== section.approved.listHash && { listChanged: 'The shopping list changed since approval; match and approve again.' }),
      });
    },
  );

  server.registerTool(
    'mark_instacart_checked_out',
    {
      description: "Record that the household checked out the week's Instacart order.",
      inputSchema: z.object({ week: WeekDate }),
    },
    async ({ week: date }) => {
      const household = await member();
      const { week, section } = await weekSection(household, date);
      await weeks.saveInstacart(household.id, week.id, { ...section, checkedOut: { by: actingUid } });
      return jsonResult({ week: week.id, checkedOut: true });
    },
  );
};

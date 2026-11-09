import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { chooseWeek } from '../core/calendar.ts';
import { cartLines, linesToSend, listHash } from '../core/kroger-cart.ts';
import { inStock, matchItem, veganCheckFor, type MatchedItem } from '../core/kroger-match.ts';
import type { KrogerSession } from '../core/kroger-session.ts';
import type { ListItem } from '../core/shopping-list.ts';
import { concernKey, ingredientsHash } from '../core/vegan.ts';
import type { Decisions } from '../data/decisions.ts';
import type { Household } from '../data/household.ts';
import { withStoreSearch, type IngredientRegistry } from '../data/ingredients.ts';
import {
  blankMemory,
  forIngredient,
  rememberedId,
  type ProductMemory,
  type RememberedProduct,
  type VeganLine,
} from '../data/product-memory.ts';
import { loadWeeks, type KrogerSection, type Weeks } from '../data/weeks.ts';
import type { Kroger, KrogerProduct } from '../sources/kroger.ts';
import type { KrogerAccount } from '../sources/kroger-account.ts';
import { signInListener } from './kroger-signin.ts';
import { inBatches, jsonResult, WeekDate } from './shared.ts';

const KROGER_PARALLEL = 4;

interface KrogerToolDeps {
  member: () => Promise<Household>;
  kroger: Kroger | null;
  productMemory: ProductMemory;
  veganLine: VeganLine;
  ingredients: IngredientRegistry;
  decisions: Decisions;
  actingUid: string;
  buyList: (household: Household, date: string | undefined) => Promise<{ week: string; buy: ListItem[] }>;
  weeks: Weeks;
  session: KrogerSession | null;
  account: KrogerAccount | null;
}

const Upc = z.string().regex(/^\d{13}$/, 'A 13-digit UPC, as match_kroger or search_kroger shows it');
const Ingredient = z.string().min(1).describe('The ingredient as build_list or list_ingredients shows it');

const shown = (product: KrogerProduct) => ({
  upc: product.upc,
  brand: product.brand,
  description: product.description,
  size: product.size,
  price: product.price,
  salePrice: product.salePrice,
  stock: product.stock,
  aisle: product.aisle,
  declaredVegan: product.declaredVegan,
  allergens: product.allergens,
  link: product.link,
});

export const registerKrogerTools = (
  server: McpServer,
  { member, kroger, productMemory, veganLine, ingredients, decisions, actingUid, buyList, weeks, session, account }: KrogerToolDeps,
) => {
  const requireKroger = () => {
    if (!kroger) throw new Error("Kroger isn't set up: add KROGER_CLIENT_ID and KROGER_CLIENT_SECRET to app/.env and restart the server.");
    return kroger;
  };

  const storeOf = (household: Household) => {
    const locationId = household.settings.kroger?.locationId;
    if (!locationId) throw new Error("The household's Kroger store isn't chosen yet; find it with find_kroger_stores and save it with update_settings.");
    return locationId;
  };

  const productAt = async (upc: string, locationId: string) => {
    const [product] = await requireKroger().lookup([upc], locationId);
    if (!product) throw new Error(`Kroger has no product ${upc} at the household's store.`);
    return product;
  };

  const knownIngredient = async (householdId: string, ingredient: string) => {
    const entries = await ingredients.list(householdId);
    const entry = entries.find(({ name }) => name === ingredient);
    if (!entry) throw new Error(`"${ingredient}" isn't a known ingredient. Use the name build_list or list_ingredients shows.`);
    return { entries, entry };
  };

  const matchWeek = async (household: Household, date: string | undefined, perItem: number) => {
    const locationId = storeOf(household);
    const store = requireKroger();
    const [{ week, buy }, memory, tallies, entries] = await Promise.all([
      buyList(household, date),
      productMemory.list(household.id),
      veganLine.tallies(household.id),
      ingredients.list(household.id),
    ]);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const remembers = (ingredient: string) => [...forIngredient(memory, ingredient, 'preferred'), ...forIngredient(memory, ingredient, 'alternate')];
    const rememberedUpcs = [...new Set(buy.flatMap(({ ingredient }) => remembers(ingredient)).map(({ upc }) => upc))];
    const remembered = new Map((await store.lookup(rememberedUpcs, locationId)).map((product) => [product.upc, product]));

    const items: MatchedItem[] = await inBatches(buy, KROGER_PARALLEL, async (item) => {
      const settled = remembers(item.ingredient).some(({ upc }) => {
        const product = remembered.get(upc);
        return product !== undefined && inStock(product);
      });
      const rejected = forIngredient(memory, item.ingredient, 'rejected').length;
      const term = byName.get(item.ingredient)?.storeSearch ?? item.ingredient;
      const found = settled ? [] : await store.search(term, locationId, Math.min(50, perItem + rejected));
      const matched = matchItem(item, { entry: byName.get(item.ingredient), memory, remembered, found, tallies });
      return { ...matched, candidates: matched.candidates.slice(0, perItem) };
    });
    return { week, locationId, items, buy };
  };

  server.registerTool(
    'find_kroger_stores',
    {
      description:
        "Find Kroger-family stores near a zip code, to choose the household's store. The zip code is only used for this search and never kept. Save the chosen store with update_settings as kroger.locationId; it must be the store the household's Kroger account has selected, because that's where cart items land.",
      inputSchema: z.object({ zipCode: z.string().regex(/^\d{5}$/, 'A 5-digit zip code') }),
    },
    async ({ zipCode }) => {
      await member();
      return jsonResult(await requireKroger().stores(zipCode));
    },
  );

  server.registerTool(
    'search_kroger',
    {
      description:
        "Search the household's Kroger store for anything, live from Kroger: description, brand, size, price and sale price, stock, aisle, whether the maker declares it vegan, the allergens it contains, and its link. Use it to find the right product when match_kroger's are wrong. Show Kroger's data as it comes; it's never stored or compared with other stores.",
      inputSchema: z.object({
        terms: z.array(z.string().min(1)).min(1).describe('What to search for'),
        perTerm: z.number().int().min(1).max(10).optional().describe('Products for each term; 5 if left out'),
      }),
    },
    async ({ terms, perTerm = 5 }) => {
      const household = await member();
      const locationId = storeOf(household);
      const store = requireKroger();
      return jsonResult(
        await inBatches(terms, KROGER_PARALLEL, async (term) => ({ term, products: (await store.search(term, locationId, perTerm)).map(shown) })),
      );
    },
  );

  server.registerTool(
    'match_kroger',
    {
      description:
        "Match a week's buy list to products at the household's Kroger store, live from Kroger. Each item uses the product the household chose before when it's in stock, then a remembered alternate; otherwise it shows search results to choose from, leaving out products the household rejected for it. Every product comes with its vegan verdict (vegan, non-vegan, or needs-review with the reasons) and how many packages cover the need. Ask the household to pick with choose_product, to reject wrong ones with reject_product, to teach a better search with set_store_search, and to answer vegan flags with review_vegan. Show Kroger's data as it comes; it's never stored or compared with other stores.",
      inputSchema: z.object({
        week: WeekDate,
        perItem: z.number().int().min(1).max(10).optional().describe('Search results to show for an item without a choice; 3 if left out'),
      }),
    },
    async ({ week: date, perItem = 3 }) => {
      const { week, locationId, items } = await matchWeek(await member(), date, perItem);
      return jsonResult({
        week,
        storeId: locationId,
        chosen: items.filter(({ pick }) => pick).length,
        toChoose: items.filter(({ pick, candidates }) => !pick && candidates.length > 0).length,
        gaps: items.filter(({ pick, candidates }) => !pick && candidates.length === 0).map(({ ingredient }) => ingredient),
        items,
      });
    },
  );

  const remember = async (household: Household, changes: Partial<RememberedProduct> & { upc: string }) => {
    const memory = await productMemory.list(household.id);
    const id = rememberedId('kroger', changes.upc, changes.ingredient ?? null);
    const current = memory.find((product) => product.id === id) ?? blankMemory(changes.upc, actingUid, changes.ingredient ?? null);
    const saved = { ...current, ...changes, decidedBy: actingUid };
    return { memory, saved };
  };

  server.registerTool(
    'choose_product',
    {
      description:
        "Record the Kroger product the household buys for an ingredient: as its usual product, or as an alternate for when the usual one is out of stock. Économe uses it from then on, and it's saved as a decision. A product whose vegan verdict is non-vegan can't be chosen until the household reviews it with review_vegan. Only the household's decision is kept, never Kroger's description or price.",
      inputSchema: z.object({
        ingredient: Ingredient,
        upc: Upc,
        as: z.enum(['preferred', 'alternate']).optional().describe('preferred (the usual product) if left out'),
        covers: z
          .number()
          .positive()
          .optional()
          .describe("How much one package covers, in the list's unit for this ingredient, when the size doesn't say, such as 7 for a bunch of green onions"),
      }),
    },
    async ({ ingredient, upc, as = 'preferred', covers }) => {
      const household = await member();
      await knownIngredient(household.id, ingredient);
      const product = await productAt(upc, storeOf(household));
      const { memory, saved } = await remember(household, { upc, ingredient, role: as, reason: null, ...(covers && { covers }) });
      const vegan = veganCheckFor(product, memory, await veganLine.tallies(household.id));
      if (vegan.verdict === 'non-vegan') {
        throw new Error(`${product.description} looks non-vegan (${vegan.reasons.join('; ')}). If that's wrong, review it with review_vegan first.`);
      }
      const demoted = as === 'preferred'
        ? forIngredient(memory, ingredient, 'preferred').filter((other) => other.upc !== upc).map((other) => ({ ...other, role: 'alternate' as const }))
        : [];
      await productMemory.save(household.id, [saved, ...demoted]);
      await decisions.record(household.id, {
        kind: 'product-choice',
        input: { ingredient, store: 'kroger' },
        suggestion: demoted.map((other) => other.upc),
        answer: { upc, role: as, covers: covers ?? null },
        by: actingUid,
      });
      return jsonResult({
        ingredient,
        chosen: shown(product),
        as,
        vegan,
        ...(demoted.length > 0 && { nowAlternates: demoted.map((other) => other.upc) }),
      });
    },
  );

  server.registerTool(
    'reject_product',
    {
      description:
        "Record that a Kroger product is wrong for an ingredient, such as canned green beans when the recipes want fresh, so match_kroger never offers it for that ingredient again. Saved as a decision; choose_product can bring it back.",
      inputSchema: z.object({ ingredient: Ingredient, upc: Upc, reason: z.string().min(1).optional() }),
    },
    async ({ ingredient, upc, reason }) => {
      const household = await member();
      await knownIngredient(household.id, ingredient);
      const { saved } = await remember(household, { upc, ingredient, role: 'rejected', reason: reason ?? null });
      await productMemory.save(household.id, [saved]);
      await decisions.record(household.id, {
        kind: 'product-choice',
        input: { ingredient, store: 'kroger' },
        suggestion: upc,
        answer: { upc, role: 'rejected', reason: reason ?? null },
        by: actingUid,
      });
      return jsonResult({ ingredient, rejected: upc, ...(reason && { reason }) });
    },
  );

  server.registerTool(
    'set_store_search',
    {
      description:
        'Teach Économe what to search the store for when an ingredient\'s own name finds the wrong products, such as "fresh green beans" for green beans. Kept for every later match and saved as a decision.',
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
        "Answer a vegan flag on a Kroger product: vegan or not, as the household judges it. The answer sticks to the product until its ingredients change, and teaches Économe the household's line: once a concern (natural flavors, sugar, shared equipment and the like) has three answers the same way and none the other way, it's decided automatically. Saved as a decision.",
      inputSchema: z.object({ upc: Upc, vegan: z.boolean(), note: z.string().min(1).optional() }),
    },
    async ({ upc, vegan, note }) => {
      const household = await member();
      const product = await productAt(upc, storeOf(household));
      const [tallies, { memory, saved }] = await Promise.all([veganLine.tallies(household.id), remember(household, { upc })]);
      const before = veganCheckFor(product, memory.filter((remembered) => remembered.upc !== upc || remembered.ingredient !== null), tallies);
      const concerns = before.verdict === 'needs-review' ? before.reasons.map(concernKey) : [];
      await productMemory.save(household.id, [
        { ...saved, vegan: { vegan, concerns, ingredientsHash: ingredientsHash(product.label.ingredients), by: actingUid } },
      ]);
      if (concerns.length > 0) await veganLine.count(household.id, concerns, vegan);
      await decisions.record(household.id, {
        kind: 'vegan-review',
        input: { upc, ingredients: product.label.ingredients, concerns },
        suggestion: { verdict: before.verdict, reasons: before.reasons },
        answer: { vegan, note: note ?? null },
        by: actingUid,
      });
      return jsonResult({ product: product.description, vegan, wasJudged: before, ...(concerns.length > 0 && { counted: concerns }) });
    },
  );
  const requireSession = () => {
    if (!session || !account) {
      throw new Error("Kroger sign-in isn't set up: add KROGER_CLIENT_ID, KROGER_CLIENT_SECRET and ECONOME_TOKEN_KEY to app/.env and restart the server.");
    }
    return { session, account };
  };

  const signIns = signInListener(async ({ householdId, uid }, code) => {
    await requireSession().session.connect(householdId, uid, code);
  });

  server.registerTool(
    'connect_kroger',
    {
      description:
        "Start connecting the household's Kroger account, so approved lists can go into its cart. Returns a sign-in link to give the household: they sign in to Kroger and agree, and Kroger sends them back to a page on this computer that finishes the connection. If that page doesn't load, ask them to copy the whole address from the browser bar and finish with finish_kroger_connect. The sign-in is good for 10 minutes. The token is encrypted before it's saved.",
    },
    async () => {
      const household = await member();
      const { account: kroger } = requireSession();
      const { state, listening } = await signIns.start(household.id, actingUid);
      return jsonResult({
        signInUrl: kroger.signInUrl(state),
        ...(listening
          ? { then: 'After signing in, the page says Kroger is connected. If it fails to load, copy the address from the browser bar and pass it to finish_kroger_connect.' }
          : { then: 'Économe could not listen on this computer, so after signing in, copy the address from the browser bar (it starts with http://localhost:8765/kroger/callback) and pass it to finish_kroger_connect.' }),
      });
    },
  );

  server.registerTool(
    'finish_kroger_connect',
    {
      description:
        "Finish connecting Kroger from the address the browser landed on after signing in, when the page on this computer didn't load. The address holds a one-time code that's used straight away.",
      inputSchema: z.object({ address: z.url().describe('The whole address from the browser bar, starting http://localhost:8765/kroger/callback') }),
    },
    async ({ address }) => {
      await member();
      await signIns.finishFromUrl(address);
      return jsonResult({ connected: true });
    },
  );

  server.registerTool(
    'disconnect_kroger',
    { description: "Remove the household's Kroger connection. Économe can still search the store, but it can't add to the cart until someone connects again." },
    async () => {
      const household = await member();
      await requireSession().session.disconnect(household.id);
      return jsonResult({ connected: false });
    },
  );

  const weekSection = async (household: Household, date: string | undefined) => {
    const week = chooseWeek(household.settings.timezone, date);
    const [planned] = await loadWeeks(weeks, household.id, [week]);
    if (!planned) throw new Error(`Nothing is planned for ${week.id}.`);
    return { week, section: planned.kroger };
  };

  server.registerTool(
    'approve_kroger',
    {
      description:
        "Approve the week's Kroger cart: every item matched to a product the household chose (from match_kroger), with its package count. Items without a chosen product in stock, and gaps, stay out and are listed. Shows each line with Kroger's live description and price, and the estimated total. Only an approved list can go into the cart, and if the shopping list changes afterwards it must be approved again.",
      inputSchema: z.object({
        week: WeekDate,
        quantities: z
          .record(z.string(), z.number().int().positive())
          .optional()
          .describe("Packages to buy by ingredient, where match_kroger couldn't count them or the household wants a different number"),
      }),
    },
    async ({ week: date, quantities }) => {
      const household = await member();
      const { week, section } = await weekSection(household, date);
      const { items, buy } = await matchWeek(household, date, 1);
      const { lines, notInCart, needQuantity } = cartLines(items, quantities);
      if (needQuantity.length > 0) {
        throw new Error(`Say how many to buy of: ${needQuantity.join(', ')} (pass them in quantities), then approve again.`);
      }
      const approved: KrogerSection = { ...section, approved: { lines, listHash: listHash(buy), by: actingUid }, checkedOut: null };
      await weeks.saveKroger(household.id, week.id, approved);
      const picks = new Map(items.flatMap(({ ingredient, pick }) => (pick ? [[ingredient, pick] as const] : [])));
      const shownLines = lines.map(({ ingredient, upc, quantity }) => {
        const pick = picks.get(ingredient);
        return { ingredient, upc, quantity, description: pick?.description, unitPrice: pick?.salePrice ?? pick?.price ?? null };
      });
      const total = shownLines.reduce((sum, { quantity, unitPrice }) => sum + (unitPrice ?? 0) * quantity, 0);
      return jsonResult({
        week: week.id,
        approved: shownLines,
        estimatedTotal: Math.round(total * 100) / 100,
        ...(notInCart.length > 0 && { notInCart }),
        note: "Prices are Kroger's live ones; produce sold by weight is an estimate.",
      });
    },
  );

  server.registerTool(
    'push_kroger_cart',
    {
      description:
        "Add the week's approved lines to the household's real Kroger cart. Each line is sent once and recorded: lines sent before are skipped, and a timeout or Kroger error leaves a line 'unknown', never resent automatically, because the cart can't be read and a resend could double it. After checking the cart, resend an unknown line by passing its UPC in resend. Items land in the store selected in the household's Kroger account, so remind them to check it's the one Économe searched. They finish checkout in the Kroger app.",
      inputSchema: z.object({
        week: WeekDate,
        resend: z.array(z.string().regex(/^\d{13}$/)).optional().describe("UPCs left 'unknown' that the household checked aren't in the cart"),
        only: z.array(z.string().regex(/^\d{13}$/)).optional().describe('Send only these approved UPCs, such as one item to try the connection'),
      }),
    },
    async ({ week: date, resend, only }) => {
      const household = await member();
      const { session: tokens, account: kroger } = requireSession();
      const { week, section } = await weekSection(household, date);
      if (!section.approved) throw new Error(`${week.id}'s Kroger list isn't approved yet; approve it with approve_kroger.`);
      const { buy } = await buyList(household, date);
      if (listHash(buy) !== section.approved.listHash) {
        throw new Error("The shopping list changed since it was approved; check it with match_kroger and approve it again with approve_kroger.");
      }
      const token = await tokens.accessToken(household);
      const modality = household.settings.kroger?.modality;
      const journal = { ...section.journal };
      for (const line of linesToSend(section, resend).filter(({ upc }) => !only || only.includes(upc))) {
        const outcome = await kroger.addToCart(token, line, modality);
        journal[line.upc] = { quantity: line.quantity, status: outcome.status, message: 'message' in outcome ? outcome.message : null };
        await weeks.saveKroger(household.id, week.id, { ...section, journal });
      }
      const lines = section.approved.lines.map(({ ingredient, upc, quantity }) => ({
        ingredient,
        upc,
        quantity,
        status: journal[upc]?.status ?? 'not sent',
        ...(journal[upc]?.message && { message: journal[upc]?.message }),
      }));
      return jsonResult({
        week: week.id,
        sent: lines.filter(({ status }) => status === 'sent').length,
        unknown: lines.filter(({ status }) => status === 'unknown'),
        failed: lines.filter(({ status }) => status === 'failed'),
        lines,
        checkout: 'https://www.kroger.com/cart',
        reminder: `Check the Kroger account has store ${storeOf(household)} selected, since that's where the items landed.`,
      });
    },
  );

  server.registerTool(
    'mark_kroger_checked_out',
    {
      description:
        "Record that the household checked out the week's Kroger order. The lines sent are kept as bought, and the push journal is cleared, as Kroger's rules ask.",
      inputSchema: z.object({ week: WeekDate }),
    },
    async ({ week: date }) => {
      const household = await member();
      const { week, section } = await weekSection(household, date);
      const bought = (section.approved?.lines ?? []).filter(({ upc }) => section.journal[upc]?.status === 'sent');
      await weeks.saveKroger(household.id, week.id, { approved: null, journal: {}, checkedOut: { by: actingUid, lines: bought } });
      return jsonResult({ week: week.id, checkedOut: true, bought: bought.length });
    },
  );


};

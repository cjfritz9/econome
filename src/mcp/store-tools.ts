import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { Household } from '../data/household.ts';
import { retailerOf, storeService, type StoreDeps } from '../services/store.ts';
import { jsonResult, WeekDate } from './shared.ts';

const MAX_CHECKED = 20;

interface StoreToolDeps extends StoreDeps {
  member: () => Promise<Household>;
  actingUid: string;
}

const ProductId = z.string().regex(/^\d+$/, "An Instacart product_id, as the Instacart connector's search shows it");
const ProductName = z.string().min(1).describe("The product's name exactly as the Instacart connector shows it, brand included");
const Ingredient = z.string().min(1).describe('The ingredient as build_list or list_ingredients shows it');

export const registerStoreTools = (server: McpServer, { member, actingUid, ...deps }: StoreToolDeps) => {
  const store = storeService(deps, actingUid);

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
      const { week, items } = await store.matchWeek(household, date);
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
        "Check Instacart products for vegan before proposing them. Instacart gives no ingredients, so each product is looked up in USDA FoodData Central's branded foods by brand and name, its ingredient list goes through Économe's vegan check (and the household's past answers), and its name is screened too. A household review of the product overrides all of it. The verdict is vegan, non-vegan, needs-review (something in the list or name only the household can settle) or unlabelled (no ingredient list found, as for most fresh produce). Propose vegan and unlabelled products freely and point out needs-review ones; never propose non-vegan ones. Only non-vegan blocks approval: open questions wait for the week's review, so don't stop the shop to ask them.",
      inputSchema: z.object({
        products: z.array(z.object({ productId: ProductId, name: ProductName })).min(1).max(MAX_CHECKED),
      }),
    },
    async ({ products }) => jsonResult(await store.checkProducts((await member()).id, products)),
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
    async (choice) => jsonResult(await store.chooseProduct(await member(), choice)),
  );

  server.registerTool(
    'reject_product',
    {
      description:
        'Record that an Instacart product is wrong for an ingredient, such as canned green beans when the recipes want fresh, so match_instacart lists it under rejected and it is never offered for that ingredient again. Saved as a decision; choose_product can bring it back.',
      inputSchema: z.object({ ingredient: Ingredient, productId: ProductId, name: ProductName.optional(), reason: z.string().min(1).optional() }),
    },
    async (rejection) => jsonResult(await store.rejectProduct(await member(), rejection)),
  );

  server.registerTool(
    'set_store_search',
    {
      description:
        'Teach Économe what to search the Instacart store for when an ingredient\'s own name finds the wrong products, such as "fresh green beans" for green beans. match_instacart gives it as the search term from then on. Saved as a decision.',
      inputSchema: z.object({ ingredient: Ingredient, term: z.string().min(3).describe('What to search the store for') }),
    },
    async ({ ingredient, term }) => jsonResult(await store.setStoreSearch(await member(), ingredient, term)),
  );

  server.registerTool(
    'review_vegan',
    {
      description:
        "Answer a vegan flag on an Instacart product: vegan or not, as the household judges it (or as you judged a single whole food with no ingredient list, saying so in the note). The answer sticks to the product until its ingredient list in FoodData Central changes, and teaches Économe the household's line: once a concern (natural flavors, sugar and the like) has three answers the same way and none the other way, it's decided automatically. A product named or listed with a meat is always asked about. Saved as a decision.",
      inputSchema: z.object({ productId: ProductId, name: ProductName, vegan: z.boolean(), note: z.string().min(1).optional() }),
    },
    async (review) => jsonResult(await store.reviewVegan(await member(), review)),
  );

  server.registerTool(
    'approve_instacart',
    {
      description:
        "Approve the week's Instacart cart on the household's yes: every item matched to a product the household chose, with its package count. Items without a chosen product stay out and are listed. A product judged non-vegan blocks approval until another is chosen; open vegan questions and unlabelled products don't. Returns the lines to show, and connector.item_updates ready for the Instacart connector's cart tool at the household's store (quantities are set, not added, and lines sharing a product are already combined). After adding them, read the cart back and pass its items to record_instacart_cart. If the shopping list changes later, approve again.",
      inputSchema: z.object({
        week: WeekDate,
        quantities: z
          .record(z.string(), z.number().int().positive())
          .optional()
          .describe("Packages to buy by ingredient, where match_instacart couldn't count them or the household wants a different number"),
      }),
    },
    async ({ week: date, quantities }) => {
      const { week, retailer, lines, notInCart, connector } = await store.approve(await member(), date, quantities);
      return jsonResult({
        week,
        retailer,
        lines: lines.map(({ ingredient, name, productId, quantity }) => ({ ingredient, product: name ?? productId, quantity })),
        connector,
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
    async ({ week: date, items }) =>
      jsonResult(await store.recordCart(await member(), date, items.map(({ productId, quantity, name }) => ({ productId, quantity, name: name ?? null })))),
  );

  server.registerTool(
    'mark_instacart_checked_out',
    {
      description: "Record that the household checked out the week's Instacart order.",
      inputSchema: z.object({ week: WeekDate }),
    },
    async ({ week: date }) => jsonResult(await store.markCheckedOut(await member(), date)),
  );
};

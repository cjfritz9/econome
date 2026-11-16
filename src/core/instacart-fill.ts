import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import type { CartLine, InCart, SentItem } from '../data/weeks.ts';
import { weekOf, type CalendarWeek } from './calendar.ts';
import { connectorItems } from './instacart-match.ts';

const FILL_ID = /^([A-Za-z0-9_-]+)\.(\d{4}-\d{2}-\d{2})\.([0-9a-f-]{36})$/;

export const newFillId = (householdId: string, week: CalendarWeek) => `${householdId}.${week.start}.${randomUUID()}`;

export const fillTarget = (fillId: string) => {
  const [, householdId, weekStart] = fillId.match(FILL_ID) ?? [];
  if (!householdId || !weekStart || !z.iso.date().safeParse(weekStart).success) return null;
  return { householdId, week: weekOf(weekStart) };
};

const CHECKOUT_HOST = 'www.instacart.com';

export const checkoutLink = (reported: string | null | undefined) => {
  if (!reported || !URL.canParse(reported)) return null;
  const url = new URL(reported);
  if (url.protocol !== 'https:' || url.hostname !== CHECKOUT_HOST) return null;
  for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_')) url.searchParams.delete(key);
  return url.toString();
};

export const storeCheckoutLink = (storeId: string) => `https://${CHECKOUT_HOST}/store/checkout_v4?sid=${storeId}`;

export const fillRequest = (fillId: string, retailer: string, items: SentItem[], { clear = false } = {}) => ({
  fill_id: fillId,
  carts: [{ retailer, ...(clear && { clear: true }), items: connectorItems(items) }],
});

export interface ConnectorWords {
  summary: string | null;
  itemErrors: { productId: string; message: string }[];
}

export const fillOutcome = (sent: SentItem[], inCart: InCart[], approved: CartLine[], { summary, itemErrors }: ConnectorWords) => {
  const has = new Map(inCart.map(({ productId, quantity }) => [productId, quantity]));
  const nameOf = new Map(approved.map(({ productId, name, ingredient }) => [productId, name ?? ingredient]));
  const errorOf = new Map(itemErrors.map(({ productId, message }) => [productId, message]));
  const short = sent.filter(({ productId, quantity }) => (has.get(productId) ?? 0) < quantity);
  return {
    missed: short.map(({ productId }) => ({ productId, name: nameOf.get(productId) ?? null, said: errorOf.get(productId) ?? summary })),
    landed: sent.filter((item) => !short.includes(item)).map(({ productId }) => productId),
  };
};

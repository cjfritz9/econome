import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import type { CartLine } from '../data/weeks.ts';
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

export const fillRequest = (fillId: string, retailer: string, lines: CartLine[]) => ({
  fill_id: fillId,
  carts: [{ retailer, items: connectorItems(lines) }],
});

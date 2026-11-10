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

export const fillRequest = (fillId: string, retailer: string, lines: CartLine[]) => ({
  fill_id: fillId,
  carts: [{ retailer, items: connectorItems(lines) }],
});

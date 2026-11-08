import * as z from 'zod';

export const Weekday = z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
export type Weekday = z.infer<typeof Weekday>;

export interface CalendarWeek {
  id: string;
  start: string;
  end: string;
}

const DAY_MS = 86_400_000;

const toDate = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`);
const addDays = (isoDate: string, days: number) =>
  new Date(toDate(isoDate).getTime() + days * DAY_MS).toISOString().slice(0, 10);
const daysSinceMonday = (date: Date) => (date.getUTCDay() + 6) % 7;

export const weekOf = (isoDate: string): CalendarWeek => {
  const start = addDays(isoDate, -daysSinceMonday(toDate(isoDate)));
  const year = toDate(addDays(start, 3)).getUTCFullYear();
  const firstMonday = Date.UTC(year, 0, 4 - daysSinceMonday(new Date(Date.UTC(year, 0, 4))));
  const week = Math.round((toDate(start).getTime() - firstMonday) / (7 * DAY_MS)) + 1;
  return { id: `${year}-W${String(week).padStart(2, '0')}`, start, end: addDays(start, 6) };
};

export const nextMonday = (isoDate: string) => addDays(isoDate, 7 - daysSinceMonday(toDate(isoDate)));

export const todayIn = (timeZone: string, now: Date): string => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now)
    .reduce<Record<string, string>>((found, part) => ({ ...found, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const chooseWeek = (timeZone: string | undefined, date: string | undefined, now = new Date()) =>
  weekOf(date ?? nextMonday(todayIn(timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, now)));

export const weeksEndingWith = (week: CalendarWeek, count: number): CalendarWeek[] =>
  Array.from({ length: count }, (_, back) => weekOf(addDays(week.start, -7 * back)));

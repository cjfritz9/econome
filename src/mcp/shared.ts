import * as z from 'zod';

export const WeekDate = z.iso
  .date()
  .optional()
  .describe(
    'Any date in the week, as YYYY-MM-DD. Weeks run Monday to Sunday. Leave it out for the coming week, the one that starts next Monday.',
  );

export const jsonResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

export const inBatches = async <T, R>(items: T[], size: number, run: (item: T) => Promise<R>) => {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) results.push(...(await Promise.all(items.slice(start, start + size).map(run))));
  return results;
};

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as z from 'zod';
import type { Household } from '../data/household.ts';

export type Env = { Variables: { uid: string; household: Household } };

export const bearerToken = (header: string | undefined) => header?.match(/^Bearer\s+(\S+)$/i)?.[1];

export const dateParam = (c: Context<Env>) => {
  const parsed = z.iso.date().safeParse(c.req.param('date'));
  if (!parsed.success) throw new HTTPException(400, { message: 'Give the week as any date in it, as YYYY-MM-DD.' });
  return parsed.data;
};

export const productParam = (c: Context<Env>) => {
  const productId = c.req.param('productId') ?? '';
  if (!/^\d+$/.test(productId)) throw new HTTPException(400, { message: 'Give an Instacart product id.' });
  return productId;
};

export const jsonBody =async <Schema extends z.ZodType>(c: Context<Env>, schema: Schema): Promise<z.infer<Schema>> => {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) });
  return parsed.data;
};

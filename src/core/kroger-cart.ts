import { createHash } from 'node:crypto';
import type { CartLine, KrogerSection } from '../data/weeks.ts';
import type { MatchedItem } from './kroger-match.ts';
import type { ListItem } from './shopping-list.ts';

export const listHash = (buy: Pick<ListItem, 'ingredient' | 'need'>[]) =>
  createHash('sha256')
    .update(JSON.stringify(buy.map(({ ingredient, need }) => [ingredient, need]).sort()))
    .digest('hex')
    .slice(0, 16);

export const cartLines = (items: MatchedItem[], quantities: Record<string, number> = {}) => {
  const lines: CartLine[] = [];
  const notInCart: { ingredient: string; why: string }[] = [];
  const needQuantity: string[] = [];
  for (const { ingredient, pick, candidates } of items) {
    if (!pick) {
      notInCart.push({ ingredient, why: candidates.length > 0 ? 'no product chosen, or the usual one is out of stock' : 'not sold at this store' });
      continue;
    }
    const quantity = quantities[ingredient] ?? pick.packages;
    if (!quantity) {
      needQuantity.push(ingredient);
      continue;
    }
    lines.push({ ingredient, upc: pick.upc, quantity });
  }
  return { lines, notInCart, needQuantity };
};

export const linesToSend = ({ approved, journal }: KrogerSection, resend: string[] = []) =>
  (approved?.lines ?? []).filter(({ upc }) => {
    const sent = journal[upc];
    if (!sent || sent.status === 'failed') return true;
    return sent.status === 'unknown' && resend.includes(upc);
  });

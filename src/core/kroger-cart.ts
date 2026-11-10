import { createHash } from 'node:crypto';
import type { CartLine, KrogerSection } from '../data/weeks.ts';
import type { MatchedItem } from './kroger-match.ts';
import type { ListItem } from './shopping-list.ts';

export const listHash = (items: Pick<ListItem, 'ingredient' | 'need'>[]) =>
  createHash('sha256')
    .update(JSON.stringify(items.map(({ ingredient, need }) => [ingredient, need]).sort()))
    .digest('hex')
    .slice(0, 16);

const usableTop = ({ candidates }: MatchedItem) =>
  candidates.find(({ stock, vegan }) => stock !== 'TEMPORARILY_OUT_OF_STOCK' && vegan.verdict === 'vegan');

export const cartLines = (items: MatchedItem[], quantities: Record<string, number> = {}, useTopMatch = false) => {
  const lines: CartLine[] = [];
  const topMatched: string[] = [];
  const notInCart: { ingredient: string; why: string }[] = [];
  const needQuantity: string[] = [];
  for (const item of items) {
    const { ingredient, candidates } = item;
    const top = useTopMatch && !item.pick ? usableTop(item) : undefined;
    if (top) topMatched.push(ingredient);
    const pick = item.pick ?? top;
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
  return { lines, notInCart, needQuantity, topMatched };
};

export const linesToSend = ({ approved, journal }: KrogerSection, resend: string[] = []) =>
  (approved?.lines ?? []).filter(({ upc }) => {
    const sent = journal[upc];
    if (!sent || sent.status === 'failed') return true;
    return sent.status === 'unknown' && resend.includes(upc);
  });

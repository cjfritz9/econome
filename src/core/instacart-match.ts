import { createHash } from 'node:crypto';
import type { IngredientEntry } from '../data/ingredients.ts';
import { forIngredient, productRecord, type RememberedProduct } from '../data/product-memory.ts';
import type { CartLine, InCart } from '../data/weeks.ts';
import { packagesCovering, packagesFor } from './packages.ts';
import type { ListItem } from './shopping-list.ts';
import type { Verdict } from './vegan.ts';

const NO_WEIGHTS = { gramsPerMl: null, unitWeights: {} };

export interface ProductPick {
  productId: string;
  name: string | null;
  size: string | null;
  packages: number | null;
  vegan: { verdict: Verdict | 'unchecked'; reasons: string[] };
  source: 'your choice' | 'your alternate';
}

export interface MatchedItem {
  ingredient: string;
  need: string | null;
  status: 'chosen' | 'choose';
  pick: ProductPick | null;
  alternates: ProductPick[];
  search: string | null;
  rejected: string[];
}

const packagesOf = (item: ListItem, product: RememberedProduct, entry: IngredientEntry | undefined) => {
  if (!item.amount) return null;
  return product.covers ? packagesCovering(item.amount, product.covers) : packagesFor(item.amount, product.size, entry ?? NO_WEIGHTS);
};

const veganOf = (memory: RememberedProduct[], productId: string): ProductPick['vegan'] => {
  const record = productRecord(memory, productId);
  if (record?.vegan) return { verdict: record.vegan.vegan ? 'vegan' : 'non-vegan', reasons: ['your review'] };
  if (record?.check) return { verdict: record.check.verdict, reasons: record.check.reasons };
  return { verdict: 'unchecked', reasons: ['not checked yet: check it with check_vegan'] };
};

const pickOf = (item: ListItem, product: RememberedProduct, memory: RememberedProduct[], entry: IngredientEntry | undefined, source: ProductPick['source']): ProductPick => ({
  productId: product.productId,
  name: product.name,
  size: product.size,
  packages: packagesOf(item, product, entry),
  vegan: veganOf(memory, product.productId),
  source,
});

export const matchItem = (item: ListItem, memory: RememberedProduct[], entry: IngredientEntry | undefined): MatchedItem => {
  const [usual] = forIngredient(memory, item.ingredient, 'preferred');
  const alternates = forIngredient(memory, item.ingredient, 'alternate').map((product) => pickOf(item, product, memory, entry, 'your alternate'));
  const rejected = forIngredient(memory, item.ingredient, 'rejected').map(({ productId }) => productId);
  const pick = usual ? pickOf(item, usual, memory, entry, 'your choice') : null;
  return {
    ingredient: item.ingredient,
    need: item.need,
    status: pick ? 'chosen' : 'choose',
    pick,
    alternates,
    search: pick ? null : (entry?.storeSearch ?? item.ingredient),
    rejected,
  };
};

export const listHash = (items: Pick<ListItem, 'ingredient' | 'need'>[]) =>
  createHash('sha256')
    .update(JSON.stringify(items.map(({ ingredient, need }) => [ingredient, need]).sort()))
    .digest('hex')
    .slice(0, 16);

export const cartLines = (items: MatchedItem[], quantities: Record<string, number> = {}) => {
  const lines: CartLine[] = [];
  const notInCart: string[] = [];
  const needQuantity: string[] = [];
  for (const { ingredient, pick } of items) {
    if (!pick) {
      notInCart.push(ingredient);
      continue;
    }
    const quantity = quantities[ingredient] ?? pick.packages;
    if (!quantity) {
      needQuantity.push(ingredient);
      continue;
    }
    lines.push({ ingredient, productId: pick.productId, quantity, name: pick.name });
  }
  return { lines, notInCart, needQuantity };
};

export const compareCart = (approved: CartLine[], inCart: InCart[]) => {
  const wanted = new Map<string, { quantity: number; names: string[] }>();
  for (const { productId, quantity, ingredient, name } of approved) {
    const current = wanted.get(productId) ?? { quantity: 0, names: [] };
    wanted.set(productId, { quantity: current.quantity + quantity, names: [...current.names, name ?? ingredient] });
  }
  const found = new Map(inCart.map((line) => [line.productId, line]));
  const missing = [...wanted].filter(([productId]) => !found.has(productId)).map(([productId, { quantity, names }]) => ({ productId, quantity, for: names }));
  const differs = [...wanted].flatMap(([productId, { quantity, names }]) => {
    const line = found.get(productId);
    return line && line.quantity !== quantity ? [{ productId, wanted: quantity, inCart: line.quantity, for: names }] : [];
  });
  const extra = inCart.filter(({ productId }) => !wanted.has(productId));
  return { matches: missing.length === 0 && differs.length === 0, missing, differs, extra };
};

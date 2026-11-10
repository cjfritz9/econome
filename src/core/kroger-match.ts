import type { IngredientEntry } from '../data/ingredients.ts';
import { forIngredient, reviewOf, type RememberedProduct } from '../data/product-memory.ts';
import type { KrogerProduct } from '../sources/kroger.ts';
import { packagesCovering, packagesFor } from './packages.ts';
import type { ListItem } from './shopping-list.ts';
import { checkVegan, type ConcernTally, type VeganCheck } from './vegan.ts';

const OUT_OF_STOCK = 'TEMPORARILY_OUT_OF_STOCK';
const NO_WEIGHTS = { gramsPerMl: null, unitWeights: {} };

export interface ProductView {
  upc: string;
  description: string;
  brand: string | null;
  size: string | null;
  price: number | null;
  salePrice: number | null;
  stock: string | null;
  aisle: string | null;
  link: string | null;
  vegan: Pick<VeganCheck, 'verdict' | 'reasons'>;
  packages: number | null;
}

export interface MatchedItem {
  ingredient: string;
  need: string | null;
  status: 'picked' | 'choose' | 'unavailable' | 'gap';
  pick: (ProductView & { source: 'your choice' | 'your alternate' }) | null;
  candidates: ProductView[];
  notes: string[];
}

export const inStock = ({ stock }: KrogerProduct) => stock !== OUT_OF_STOCK;

export const veganCheckFor = (product: KrogerProduct, memory: RememberedProduct[], tallies: Map<string, ConcernTally>) => {
  return checkVegan(product.label, tallies, reviewOf(memory, product.upc, 'kroger'));
};

const packagesOf = (product: KrogerProduct, item: ListItem, entry: IngredientEntry | undefined, covers: number | null) => {
  if (!item.amount) return null;
  return covers ? packagesCovering(item.amount, covers) : packagesFor(item.amount, product.size, entry ?? NO_WEIGHTS);
};

const view = (
  product: KrogerProduct,
  item: ListItem,
  entry: IngredientEntry | undefined,
  vegan: VeganCheck,
  covers: number | null,
): ProductView => ({
  upc: product.upc,
  description: product.description,
  brand: product.brand,
  size: product.size,
  price: product.price,
  salePrice: product.salePrice,
  stock: product.stock,
  aisle: product.aisle,
  link: product.link,
  vegan: { verdict: vegan.verdict, reasons: vegan.reasons },
  packages: packagesOf(product, item, entry, covers),
});

export const matchItem = (
  item: ListItem,
  { entry, memory, remembered, found, tallies }: {
    entry: IngredientEntry | undefined;
    memory: RememberedProduct[];
    remembered: Map<string, KrogerProduct>;
    found: KrogerProduct[];
    tallies: Map<string, ConcernTally>;
  },
): MatchedItem => {
  const notes: string[] = [];
  const show = (product: KrogerProduct) => {
    const covers = memory.find(({ productId, ingredient }) => productId === product.upc && ingredient === item.ingredient)?.covers ?? null;
    return view(product, item, entry, veganCheckFor(product, memory, tallies), covers);
  };
  const usable = (upc: string) => {
    const product = remembered.get(upc);
    return product && inStock(product) ? product : null;
  };
  const result = (status: MatchedItem['status'], pick: MatchedItem['pick'], candidates: ProductView[] = []): MatchedItem => ({
    ingredient: item.ingredient,
    need: item.need,
    status,
    pick,
    candidates,
    notes,
  });

  const preferred = forIngredient(memory, item.ingredient, 'preferred');
  const alternates = forIngredient(memory, item.ingredient, 'alternate');
  const choice = preferred.map(({ productId }) => usable(productId)).find(Boolean);
  if (choice) return result('picked', { ...show(choice), source: 'your choice' });

  for (const { productId } of preferred) {
    notes.push(remembered.has(productId) ? `Your usual product (${productId}) is out of stock.` : `Your usual product (${productId}) isn't sold at this store now.`);
  }
  const alternate = alternates.map(({ productId }) => usable(productId)).find(Boolean);
  if (alternate) return result('picked', { ...show(alternate), source: 'your alternate' });

  const rejected = new Set(forIngredient(memory, item.ingredient, 'rejected').map(({ productId }) => productId));
  const candidates = found.filter(({ upc }) => !rejected.has(upc)).map(show);
  if (preferred.length > 0) return result('unavailable', null, candidates);
  if (candidates.length === 0) {
    notes.push('Nothing found at this store: it falls back to Whole Foods.');
    return result('gap', null);
  }
  return result('choose', null, candidates);
};

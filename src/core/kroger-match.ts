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
  pick: (ProductView & { source: 'your choice' | 'your alternate' }) | null;
  candidates: ProductView[];
  notes: string[];
}

export const inStock = ({ stock }: KrogerProduct) => stock !== OUT_OF_STOCK;

export const veganCheckFor = (product: KrogerProduct, memory: RememberedProduct[], tallies: Map<string, ConcernTally>) => {
  return checkVegan(product.label, tallies, reviewOf(memory, product.upc));
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
    const covers = memory.find(({ upc, ingredient }) => upc === product.upc && ingredient === item.ingredient)?.covers ?? null;
    return view(product, item, entry, veganCheckFor(product, memory, tallies), covers);
  };
  const usable = (upc: string) => {
    const product = remembered.get(upc);
    return product && inStock(product) ? product : null;
  };

  const preferred = forIngredient(memory, item.ingredient, 'preferred');
  const alternates = forIngredient(memory, item.ingredient, 'alternate');
  const choice = preferred.map(({ upc }) => usable(upc)).find(Boolean);
  if (choice) return { ingredient: item.ingredient, need: item.need, pick: { ...show(choice), source: 'your choice' }, candidates: [], notes };

  for (const { upc } of preferred) {
    notes.push(remembered.has(upc) ? `Your usual product (${upc}) is out of stock.` : `Your usual product (${upc}) isn't sold at this store now.`);
  }
  const alternate = alternates.map(({ upc }) => usable(upc)).find(Boolean);
  if (alternate) return { ingredient: item.ingredient, need: item.need, pick: { ...show(alternate), source: 'your alternate' }, candidates: [], notes };

  const rejected = new Set(forIngredient(memory, item.ingredient, 'rejected').map(({ upc }) => upc));
  const candidates = found.filter(({ upc }) => !rejected.has(upc)).map(show);
  if (candidates.length === 0) notes.push('Nothing found at this store: a gap for Whole Foods or an online order.');
  return { ingredient: item.ingredient, need: item.need, pick: null, candidates, notes };
};

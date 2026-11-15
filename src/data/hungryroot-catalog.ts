import type { CatalogRecipe } from '../core/hungryroot-translate.ts';
import type { HungryrootProduct } from '../sources/hungryroot.ts';

export interface StoredCatalogEntry {
  hash: string;
  gone: boolean;
}

export interface CatalogChange {
  recipe: CatalogRecipe;
  hash: string;
  isNew: boolean;
}

export interface CatalogRun {
  read: number;
  of: number;
  complete: boolean;
  added: number;
  updated: number;
  unchanged: number;
  back: number;
  gone: number;
  products: number;
  imageHostsLeftOff: string[];
}

export interface HungryrootCatalogStore {
  entries: () => Promise<Map<string, StoredCatalogEntry>>;
  saveRecipes: (changes: CatalogChange[]) => Promise<void>;
  markGone: (ids: string[]) => Promise<void>;
  saveProducts: (products: HungryrootProduct[]) => Promise<void>;
  saveRun: (run: CatalogRun) => Promise<void>;
}

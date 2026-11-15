import { describe, expect, it } from 'vitest';
import { catalogRecipe, recipeHash } from '../../src/core/hungryroot-translate.ts';
import type { CatalogChange, CatalogRunRecord, HungryrootCatalogStore, StoredCatalogEntry } from '../../src/data/hungryroot-catalog.ts';
import { syncHungryrootCatalog } from '../../src/services/hungryroot-catalog-sync.ts';
import type { HungryrootProduct, HungryrootRecipe } from '../../src/sources/hungryroot.ts';

const recipe = (id: number, overrides: Partial<HungryrootRecipe> = {}): HungryrootRecipe => ({
  id,
  name: `Recipe ${id}`,
  slug: `recipe-${id}`,
  servings: 2,
  credits: 8,
  minutes: 10,
  nutrition: { kcal: 400, protein: 25, carbs: 40, fat: 10, fiber: 8, sugar: 4 },
  tags: ['Vegan'],
  products: [],
  steps: ['Cook it'],
  featured: true,
  image: 'https://d219o304zcx1el.cloudfront.net/x.jpg',
  ...overrides,
});

const PRODUCT: HungryrootProduct = {
  id: 7,
  name: 'Tofu',
  brand: null,
  credits: 3,
  category: null,
  servings: 4,
  servingSize: null,
  perServing: null,
  ingredients: null,
  dietaryTags: [],
};

const memoryStore = (entries: Record<string, StoredCatalogEntry> = {}) => {
  const saved: CatalogChange[] = [];
  const gone: string[] = [];
  const runs: CatalogRunRecord[] = [];
  let products: HungryrootProduct[] = [];
  const store: HungryrootCatalogStore = {
    entries: async () => new Map(Object.entries(entries)),
    saveRecipes: async (changes) => {
      saved.push(...changes);
    },
    markGone: async (ids) => {
      gone.push(...ids);
    },
    saveProducts: async (list) => {
      products = list;
    },
    recordRun: async (record) => {
      runs.push(record);
    },
    recentRuns: async (limit) => runs.slice(-limit).reverse(),
    findRecipes: async () => [],
  };
  return { store, saved, gone, runs, products: () => products };
};

const source = (recipes: HungryrootRecipe[], count = recipes.length) => ({
  everyVeganRecipe: async () => ({ count, recipes }),
  products: async () => [PRODUCT],
});

const hashOf = (found: HungryrootRecipe) => recipeHash(catalogRecipe(found));

describe('syncHungryrootCatalog', () => {
  it('writes new and changed recipes, leaves unchanged ones alone, and saves the products', async () => {
    const same = recipe(2);
    const memory = memoryStore({
      'recipe-2': { hash: hashOf(same), gone: false },
      'recipe-3': { hash: 'old', gone: false },
    });

    const run = await syncHungryrootCatalog({ source: source([recipe(1), same, recipe(3)]), store: memory.store });

    expect(memory.saved.map(({ recipe: { id }, isNew }) => [id, isNew])).toEqual([
      ['recipe-1', true],
      ['recipe-3', false],
    ]);
    expect(memory.products()).toEqual([PRODUCT]);
    expect(run).toMatchObject({ read: 3, of: 3, complete: true, added: 1, updated: 1, unchanged: 1, gone: 0, back: 0, products: 1 });
  });

  it('records each run with when it started and how long it took', async () => {
    const memory = memoryStore();
    const times = [new Date('2026-12-01T09:00:00Z'), new Date('2026-12-01T09:02:30Z')];

    const run = await syncHungryrootCatalog({ source: source([recipe(1)]), store: memory.store, now: () => times.shift() ?? new Date(0) });

    expect(memory.runs).toEqual([{ at: new Date('2026-12-01T09:00:00Z'), seconds: 150, error: null, counts: run }]);
  });

  it('records a failed pull with what went wrong, writes nothing, and still fails', async () => {
    const memory = memoryStore();
    const failing = {
      everyVeganRecipe: async () => Promise.reject(new Error("Hungryroot's public catalog answered 503.")),
      products: async () => [PRODUCT],
    };

    await expect(syncHungryrootCatalog({ source: failing, store: memory.store })).rejects.toThrow('answered 503');

    expect(memory.saved).toEqual([]);
    expect(memory.products()).toEqual([]);
    expect(memory.runs).toMatchObject([{ error: "Hungryroot's public catalog answered 503.", counts: null }]);
  });

  it('marks recipes Hungryroot dropped as gone, and rewrites one that came back', async () => {
    const returning = recipe(2);
    const memory = memoryStore({
      'recipe-2': { hash: hashOf(returning), gone: true },
      'recipe-9': { hash: 'x', gone: false },
      'recipe-8': { hash: 'x', gone: true },
    });

    const run = await syncHungryrootCatalog({ source: source([returning]), store: memory.store });

    expect(memory.gone).toEqual(['recipe-9']);
    expect(memory.saved.map(({ recipe: { id } }) => id)).toEqual(['recipe-2']);
    expect(run).toMatchObject({ gone: 1, back: 1 });
  });

  it('marks nothing gone when the pull came back short, since a missing recipe may just have been skipped', async () => {
    const memory = memoryStore({ 'recipe-9': { hash: 'x', gone: false } });

    const run = await syncHungryrootCatalog({ source: source([recipe(1)], 2), store: memory.store });

    expect(memory.gone).toEqual([]);
    expect(run).toMatchObject({ read: 1, of: 2, complete: false, gone: 0 });
  });

  it('writes a recipe seen twice across pages once', async () => {
    const memory = memoryStore();

    const run = await syncHungryrootCatalog({ source: source([recipe(1), recipe(1)], 1), store: memory.store });

    expect(memory.saved).toHaveLength(1);
    expect(run).toMatchObject({ read: 1, complete: true });
  });

  it('names the image hosts it had to leave off', async () => {
    const memory = memoryStore();

    const run = await syncHungryrootCatalog({
      source: source([recipe(1, { image: 'https://other.example/a.jpg' }), recipe(2, { image: 'https://other.example/b.jpg' })]),
      store: memory.store,
    });

    expect(run.imageHostsLeftOff).toEqual(['other.example']);
    expect(memory.saved.every(({ recipe: copy }) => !copy.images)).toBe(true);
  });
});

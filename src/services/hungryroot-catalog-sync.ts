import { catalogRecipe, recipeHash, servableImage } from '../core/hungryroot-translate.ts';
import type { CatalogChange, CatalogRun, HungryrootCatalogStore } from '../data/hungryroot-catalog.ts';
import type { HungryrootCatalog } from '../sources/hungryroot.ts';

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const syncHungryrootCatalog = async ({
  source,
  store,
}: {
  source: Pick<HungryrootCatalog, 'everyVeganRecipe' | 'products'>;
  store: HungryrootCatalogStore;
}): Promise<CatalogRun> => {
  const { count, recipes } = await source.everyVeganRecipe();
  const products = await source.products();
  const stored = await store.entries();

  const seen = new Set<string>();
  const changes: CatalogChange[] = [];
  const imageHostsLeftOff = new Set<string>();
  let unchanged = 0;
  let back = 0;
  for (const found of recipes) {
    const recipe = catalogRecipe(found);
    if (seen.has(recipe.id)) continue;
    seen.add(recipe.id);
    if (found.image && !servableImage(found.image)) imageHostsLeftOff.add(hostOf(found.image));
    const hash = recipeHash(recipe);
    const known = stored.get(recipe.id);
    if (known && known.hash === hash && !known.gone) {
      unchanged += 1;
      continue;
    }
    if (known?.gone) back += 1;
    changes.push({ recipe, hash, isNew: !known });
  }

  await store.saveRecipes(changes);
  const complete = seen.size >= count;
  const gone = complete ? [...stored].filter(([id, entry]) => !entry.gone && !seen.has(id)).map(([id]) => id) : [];
  await store.markGone(gone);
  await store.saveProducts(products);

  const run: CatalogRun = {
    read: seen.size,
    of: count,
    complete,
    added: changes.filter(({ isNew }) => isNew).length,
    updated: changes.filter(({ isNew }) => !isNew).length,
    unchanged,
    back,
    gone: gone.length,
    products: products.length,
    imageHostsLeftOff: [...imageHostsLeftOff].sort(),
  };
  await store.saveRun(run);
  return run;
};

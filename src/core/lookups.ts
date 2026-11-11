import { randomUUID } from 'node:crypto';
import type { IngredientEntry } from '../data/ingredients.ts';
import { packagesFor } from './packages.ts';
import type { ListItem } from './shopping-list.ts';
import type { Verdict } from './vegan.ts';

export const SUGGESTIONS_KEPT = 5;

const JOB_ID = /^([A-Za-z0-9_-]+)\.([0-9a-f-]{36})$/;
const NO_WEIGHTS = { gramsPerMl: null, unitWeights: {} };

export interface LookupItem {
  ingredientId: string;
  ingredient: string;
  term: string;
}

export interface Candidate {
  productId: string;
  name: string;
  size: string | null;
}

export interface Suggestion extends Candidate {
  packages: number | null;
  vegan: { verdict: Verdict; reasons: string[] };
  why: string[];
}

export interface Excluded {
  productId: string;
  name: string;
  reason: string;
}

export interface Found {
  suggestions: Suggestion[];
  excluded: Excluded[];
}

export const newJobId = (householdId: string) => `${householdId}.${randomUUID()}`;

export const jobHousehold = (jobId: string) => jobId.match(JOB_ID)?.[1] ?? null;

export const researchRequest = (jobId: string, retailer: string, items: LookupItem[]) => ({
  job_id: jobId,
  stores: [retailer],
  items: items.map(({ ingredientId, ingredient, term }) => ({ id: ingredientId, term, for: ingredient })),
});

const isStoreBrand = (name: string, retailer: string) => name.toLowerCase().startsWith(retailer.toLowerCase());

const covering = (packages: number | null) => {
  if (packages === null) return [];
  return [packages === 1 ? '1 covers the need' : `${packages} cover the need`];
};

export const rankFound = (
  candidates: (Candidate & { vegan: { verdict: Verdict; reasons: string[] } })[],
  { item, entry, retailer, rejected }: { item: ListItem | undefined; entry: IngredientEntry | undefined; retailer: string; rejected: Set<string> },
): Found => {
  const excluded: Excluded[] = [];
  const kept: Suggestion[] = [];
  for (const { productId, name, size, vegan } of candidates) {
    if (rejected.has(productId)) excluded.push({ productId, name, reason: 'you turned it down for this' });
    else if (vegan.verdict === 'non-vegan') excluded.push({ productId, name, reason: `looks non-vegan: ${vegan.reasons.join('; ')}` });
    else {
      const packages = item?.amount ? packagesFor(item.amount, size, entry ?? NO_WEIGHTS) : null;
      const why = [...(isStoreBrand(name, retailer) ? ['store brand'] : []), ...covering(packages)];
      kept.push({ productId, name, size, packages, vegan: { verdict: vegan.verdict, reasons: vegan.reasons }, why });
    }
  }
  const shown = kept.slice(0, SUGGESTIONS_KEPT);
  const overflow = kept.slice(SUGGESTIONS_KEPT).map(({ productId, name }) => ({ productId, name, reason: `beyond the top ${SUGGESTIONS_KEPT}` }));
  return { suggestions: shown, excluded: [...excluded, ...overflow] };
};

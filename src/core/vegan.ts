import { createHash } from 'node:crypto';

export type Verdict = 'vegan' | 'non-vegan' | 'needs-review';

export interface VeganCheck {
  verdict: Verdict;
  reasons: string[];
  source: 'your review' | 'allergens' | 'declaration' | 'ingredients' | 'your past reviews' | 'produce' | 'no ingredient list';
}

export interface LabelFacts {
  ingredients: string | null;
  categories: string[];
  declarations: string[];
  contains: string[];
  mayContain: string[];
}

export interface ConcernTally {
  ok: number;
  notOk: number;
}

export interface ProductReview {
  vegan: boolean;
  ingredientsHash: string;
}

const AUTO_DECIDE_AFTER = 3;

const ANIMAL_ALLERGEN = /\b(milk|eggs?|fish|shellfish|crustaceans?|molluscs?|mollusks?)\b/i;

const PLANT = '(almond|coconut|oat|soy|rice|cashew|hemp|pea|flax|nut|peanut|cocoa|shea|seed|sunflower|vegan|plant[- ]based|dairy[- ]free)';

const DENY: [RegExp, string][] = [
  [/\bwhey\b/i, 'whey'],
  [/\bcasein(ate)?\b/i, 'casein'],
  [/\blactose\b/i, 'lactose'],
  [new RegExp(`(?<!${PLANT}[\\s-]?)\\bmilk\\b(?!\\s+(thistle|chocolate))`, 'i'), 'milk'],
  [new RegExp(`(?<!${PLANT}[\\s-]?)\\bbutter\\b`, 'i'), 'butter'],
  [new RegExp(`(?<!${PLANT}[\\s-]?)\\bcream\\b(?!\\s+of\\s+tartar)`, 'i'), 'cream'],
  [new RegExp(`(?<!${PLANT}[\\s-]?)\\bcheese\\b`, 'i'), 'cheese'],
  [/\beggs?\b|\begg (whites?|yolks?)\b/i, 'egg'],
  [/\bhoney\b/i, 'honey'],
  [/\bgelatine?\b/i, 'gelatin'],
  [/\bcarmine\b|\bcochineal\b/i, 'carmine'],
  [/\bshellac\b|confectioner'?s glaze/i, 'shellac'],
  [/\blard\b|\btallow\b/i, 'animal fat'],
  [/\banchov(y|ies)\b|\bfish\b/i, 'fish'],
  [/\bbeeswax\b/i, 'beeswax'],
  [/\bisinglass\b/i, 'isinglass'],
];

const QUESTIONABLE: [RegExp, string][] = [
  [/natural flavou?rs?/i, 'natural flavors: may be animal-derived'],
  [/vitamin d3|cholecalciferol/i, 'vitamin D3: often made from lanolin'],
  [/(?<!(organic|coconut|beet|date|maple|brown rice)\s(cane\s)?)\b(cane\s)?sugar\b/i, 'sugar: may be filtered with bone char'],
  [/mono-?\s?and\s?diglycerides|\bmonoglycerides\b|\bdiglycerides\b/i, 'mono- and diglycerides: can be animal fat'],
  [/l-cysteine/i, 'L-cysteine: can come from feathers'],
  [/\bwine\b|\bbeer\b/i, 'wine or beer: may be fined with animal products'],
  [/\bglycerine?\b|\bglycerol\b/i, 'glycerin: can be animal fat'],
  [/stearic acid|\bstearate\b/i, 'stearic acid: can be animal fat'],
  [/(?<!(soy|soya|sunflower)\s)\blecithin\b/i, 'lecithin: can come from egg'],
  [/\b(chicken|beef|pork|turkey|bacon|meat)\b/i, "names a meat: check it's plant-based"],
];

export const concernKey = (reason: string) => reason.split(':')[0]?.trim().toLowerCase() ?? reason;

export const ingredientsHash = (ingredients: string | null) =>
  createHash('sha256').update((ingredients ?? '').toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

const animal = (allergens: string[]) => allergens.filter((name) => ANIMAL_ALLERGEN.test(name));

export const checkVegan = (
  facts: LabelFacts,
  tallies: Map<string, ConcernTally> = new Map(),
  review?: ProductReview,
): VeganCheck => {
  if (review && review.ingredientsHash === ingredientsHash(facts.ingredients)) {
    return { verdict: review.vegan ? 'vegan' : 'non-vegan', reasons: ['you reviewed this product'], source: 'your review' };
  }
  const contains = animal(facts.contains);
  if (contains.length > 0) return { verdict: 'non-vegan', reasons: contains.map((name) => `contains ${name}`), source: 'allergens' };
  if (facts.declarations.some((declaration) => /^vegan$/i.test(declaration.trim()))) {
    return { verdict: 'vegan', reasons: ['the maker declares it vegan'], source: 'declaration' };
  }

  const text = facts.ingredients?.trim();
  if (!text) {
    return facts.categories.includes('Produce')
      ? { verdict: 'vegan', reasons: ['produce with no label'], source: 'produce' }
      : { verdict: 'needs-review', reasons: ['Kroger has no ingredient list for it'], source: 'no ingredient list' };
  }

  const denied = DENY.filter(([pattern]) => pattern.test(text)).map(([, name]) => `contains ${name}`);
  if (denied.length > 0) return { verdict: 'non-vegan', reasons: denied, source: 'ingredients' };

  const concerns = [
    ...QUESTIONABLE.filter(([pattern]) => pattern.test(text)).map(([, reason]) => reason),
    ...animal(facts.mayContain).map((name) => `may contain ${name}: shared equipment`),
  ];
  if (concerns.length === 0) return { verdict: 'vegan', reasons: ['no animal ingredients in its list'], source: 'ingredients' };

  const decided = (reason: string) => {
    const tally = tallies.get(concernKey(reason));
    if (!tally) return null;
    if (tally.ok >= AUTO_DECIDE_AFTER && tally.notOk === 0) return 'ok';
    if (tally.notOk >= AUTO_DECIDE_AFTER && tally.ok === 0) return 'not ok';
    return null;
  };
  const open = concerns.filter((reason) => decided(reason) === null);
  const refused = concerns.filter((reason) => decided(reason) === 'not ok');
  if (refused.length > 0) return { verdict: 'non-vegan', reasons: refused, source: 'your past reviews' };
  if (open.length === 0) return { verdict: 'vegan', reasons: concerns.map((reason) => `${concernKey(reason)}: OK by your past reviews`), source: 'your past reviews' };
  return { verdict: 'needs-review', reasons: open, source: 'ingredients' };
};

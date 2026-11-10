import type { BrandedFood } from '../sources/fdc.ts';
import { checkVegan, ingredientsHash, nameConcerns, type ConcernTally, type ProductReview, type VeganCheck } from './vegan.ts';

const MIN_BRAND_LETTERS = 3;
const MIN_STEM_LETTERS = 3;
const FILLER = new Set(['a', 'and', 'the', 'of', 'with', 'in', 'oz', 'fl', 'lb', 'ct', 'g']);

export interface ProductCheck extends VeganCheck {
  label: string | null;
}

const plain = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const letters = (text: string) => plain(text).replace(/[^a-z0-9]/g, '');
const words = (text: string) => plain(text).match(/[a-z0-9]+/g) ?? [];

export const labelQuery = (name: string) =>
  name
    .replace(/,?\s*\d[\d.]*\s*(fl oz|oz|lb|lbs|ct|count|g|ml|pk)\b.*$/i, '')
    .replace(/[®™]/g, '')
    .trim();

export const bestLabel = (name: string, foods: BrandedFood[]): BrandedFood | null => {
  const nameLetters = letters(name);
  const inName = (word: string) => {
    const singular = word.replace(/(es|s)$/, '');
    return nameLetters.includes(word) || (singular.length >= MIN_STEM_LETTERS && nameLetters.includes(singular));
  };
  const fitting = foods.flatMap((food) => {
    const brands = [food.brand, food.owner].flatMap((brand) => (brand ? [letters(brand)] : [])).filter((brand) => brand.length >= MIN_BRAND_LETTERS);
    if (!food.ingredients || !brands.some((brand) => nameLetters.includes(brand))) return [];
    const described = new Set(words(food.description).filter((word) => !FILLER.has(word)));
    return described.size > 0 && [...described].every(inName) ? [{ food, named: described.size }] : [];
  });
  return fitting.sort((a, b) => b.named - a.named)[0]?.food ?? null;
};

const facts = (ingredients: string | null) => ({ ingredients, categories: [], declarations: [], contains: [], mayContain: [] });

export const reviewHash = (label: BrandedFood | null) => ingredientsHash(label?.ingredients ?? null);

export const checkProduct = (
  name: string,
  label: BrandedFood | null,
  tallies: Map<string, ConcernTally> = new Map(),
  review?: ProductReview,
): ProductCheck => {
  const described = label ? `${label.description} (${label.brand ?? label.owner})` : null;
  const check = checkVegan(facts(label?.ingredients ?? null), tallies, review);
  if (check.source === 'your review' || check.verdict === 'non-vegan') return { ...check, label: described };

  const fromName = nameConcerns(name);
  if (!label) {
    return fromName.length > 0
      ? { verdict: 'needs-review', reasons: fromName, source: 'no ingredient list', label: null }
      : { verdict: 'needs-review', reasons: ['no ingredient list found for it in FoodData Central'], source: 'no ingredient list', label: null };
  }
  if (fromName.length === 0) return { ...check, label: described };
  return {
    verdict: 'needs-review',
    reasons: [...(check.verdict === 'needs-review' ? check.reasons : []), ...fromName],
    source: check.source,
    label: described,
  };
};

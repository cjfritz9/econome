import type { Household } from '../data/household.ts';
import { withFood, type FoodMatch, type IngredientRegistry } from '../data/ingredients.ts';
import type { ParsedLine, ParsedLines } from '../data/parsed-lines.ts';
import { SpendCapError, type Claude } from '../llm/claude.ts';
import { matchFood } from '../llm/match-food.ts';
import { logger } from '../logger.ts';
import type { FoodData } from '../sources/fdc.ts';
import { formatLine } from './ingredient-lines.ts';
import { isCountUnit, ML_PER, type CountUnit } from './units.ts';

const LINES_SHOWN = 8;

interface Usage {
  lines: string[];
  units: CountUnit[];
  needsDensity: boolean;
}

export const ingredientUsage = (lines: ParsedLine[]) => {
  const usage = new Map<string, Usage>();
  for (const { line, parse } of lines) {
    const current = usage.get(parse.ingredient) ?? { lines: [], units: [], needsDensity: false };
    const volumePackage = parse.packageSize !== null && ML_PER[parse.packageSize.unit] !== undefined;
    const looseUnit = isCountUnit(parse.unit) && parse.packageSize === null ? parse.unit : null;
    usage.set(parse.ingredient, {
      lines: [...current.lines, formatLine(line)].sort().slice(0, LINES_SHOWN),
      units: looseUnit && !current.units.includes(looseUnit) ? [...current.units, looseUnit] : current.units,
      needsDensity: current.needsDensity || ML_PER[parse.unit] !== undefined || volumePackage,
    });
  }
  return usage;
};

export interface MatchRun {
  matched: number;
  remaining: number;
  unsure: { ingredient: string; food: string; doubt: string }[];
  noFood: { ingredient: string; reason: string }[];
  failed: { ingredient: string; reason: string }[];
  stopped: string | null;
}

export const matchFoods = async (
  {
    claude,
    fdc,
    ingredients,
    parsedLines,
  }: { claude: Claude; fdc: FoodData; ingredients: IngredientRegistry; parsedLines: ParsedLines },
  household: Household,
  { names, rematch = false, limit }: { names?: string[]; rematch?: boolean; limit: number },
): Promise<MatchRun> => {
  const [lines, entries] = await Promise.all([parsedLines.list(household.id), ingredients.list(household.id)]);
  const usage = ingredientUsage(lines);
  const entryOf = new Map(entries.map((entry) => [entry.name, entry]));
  const due = (names ?? [...usage.keys()].sort()).filter((name) => {
    const food = entryOf.get(name)?.food;
    return !food || (rematch && food.source === 'claude');
  });
  const run: MatchRun = { matched: 0, remaining: due.length, unsure: [], noFood: [], failed: [], stopped: null };

  for (const name of due.slice(0, limit)) {
    try {
      const use = usage.get(name) ?? { lines: [], units: [], needsDensity: false };
      const candidates = await fdc.candidates(entryOf.get(name)?.fdcQuery ?? name);
      const result =
        candidates.length === 0
          ? { food: null, gramsPerMl: null, unitWeights: {}, doubt: 'FoodData Central found nothing for this name' }
          : await matchFood(claude, household, { ingredient: name, ...use, candidates });

      const food: FoodMatch = {
        fdcId: result.food?.fdcId ?? null,
        description: result.food?.description ?? null,
        per100g: result.food?.per100g ?? null,
        source: 'claude',
        doubt: result.doubt,
      };
      await ingredients.save(household.id, [
        withFood(entries, name, food, { gramsPerMl: result.gramsPerMl, unitWeights: result.unitWeights }),
      ]);

      run.matched += 1;
      run.remaining -= 1;
      if (food.fdcId === null) run.noFood.push({ ingredient: name, reason: food.doubt ?? 'no candidate was the same food' });
      else if (food.doubt) run.unsure.push({ ingredient: name, food: food.description ?? '', doubt: food.doubt });
      logger.info({ ingredient: name, fdcId: food.fdcId }, 'Matched ingredient to a food');
    } catch (error) {
      if (error instanceof SpendCapError) {
        run.stopped = error.message;
        break;
      }
      run.failed.push({ ingredient: name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return run;
};

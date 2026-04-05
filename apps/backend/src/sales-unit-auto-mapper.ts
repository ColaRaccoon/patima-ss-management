import {
  CanonicalSalesUnit,
  createSourceSignature,
  DatabaseShape,
  normalizeText,
  OrderSourceSignature,
} from "@patima/shared";
import { isSalesUnitAssignable, nowIso } from "./helpers";

const AUTO_MATCH_MIN_SCORE = 0.78;
const AUTO_MATCH_MIN_MARGIN = 0.02;
const NON_WORD_PATTERN = /[^\p{L}\p{N}]+/gu;

interface AutoMatchResolution {
  canonicalSalesUnitId: string | null;
  candidateCount: number;
  ambiguous: boolean;
}

const compactText = (value: string): string => value.replace(NON_WORD_PATTERN, "");

const splitTerms = (value: string): string[] => value.split(NON_WORD_PATTERN).filter(Boolean);

const getBigrams = (value: string): string[] => {
  if (!value) {
    return [];
  }
  if (value.length < 2) {
    return [value];
  }

  const grams: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.push(value.slice(index, index + 2));
  }
  return grams;
};

const getDiceCoefficient = (left: string, right: string): number => {
  const leftBigrams = getBigrams(left);
  const rightBigrams = getBigrams(right);
  if (!leftBigrams.length || !rightBigrams.length) {
    return 0;
  }

  const counts = new Map<string, number>();
  leftBigrams.forEach((gram) => {
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  });

  let overlap = 0;
  rightBigrams.forEach((gram) => {
    const remaining = counts.get(gram) ?? 0;
    if (remaining <= 0) {
      return;
    }

    counts.set(gram, remaining - 1);
    overlap += 1;
  });

  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
};

const getCommonPrefixLength = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) {
    index += 1;
  }
  return index;
};

const getCommonSuffixLength = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[left.length - 1 - index] === right[right.length - 1 - index]) {
    index += 1;
  }
  return index;
};

const isSubsequence = (needle: string, haystack: string): boolean => {
  if (!needle) {
    return false;
  }

  let pointer = 0;
  for (const character of haystack) {
    if (character === needle[pointer]) {
      pointer += 1;
      if (pointer === needle.length) {
        return true;
      }
    }
  }
  return false;
};

const getTokenCoverage = (left: string, right: string): number => {
  const leftTerms = splitTerms(left);
  const rightTerms = splitTerms(right);
  if (!leftTerms.length || !rightTerms.length || (leftTerms.length === 1 && rightTerms.length === 1)) {
    return 0;
  }

  const matchedLeftTerms = leftTerms.filter((term) =>
    rightTerms.some((candidate) => candidate === term || candidate.includes(term) || term.includes(candidate)),
  );
  const matchedRightTerms = rightTerms.filter((term) =>
    leftTerms.some((candidate) => candidate === term || candidate.includes(term) || term.includes(candidate)),
  );

  return (matchedLeftTerms.length + matchedRightTerms.length) / (leftTerms.length + rightTerms.length);
};

const getTextSimilarity = (leftRaw: string | null | undefined, rightRaw: string | null | undefined): number => {
  const left = normalizeText(leftRaw);
  const right = normalizeText(rightRaw);
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }

  const compactLeft = compactText(left);
  const compactRight = compactText(right);
  if (!compactLeft || !compactRight) {
    return 0;
  }
  if (compactLeft === compactRight) {
    return 0.99;
  }

  const [shorter, longer] =
    compactLeft.length <= compactRight.length ? [compactLeft, compactRight] : [compactRight, compactLeft];
  if (shorter.length >= 3 && longer.includes(shorter)) {
    return 0.9 + 0.1 * (shorter.length / longer.length);
  }

  const boundaryCoverage =
    Math.min(shorter.length, getCommonPrefixLength(shorter, longer) + getCommonSuffixLength(shorter, longer)) /
    shorter.length;
  const subsequenceCoverage =
    shorter.length >= 3 && isSubsequence(shorter, longer) ? shorter.length / longer.length : 0;
  const tokenCoverage = getTokenCoverage(left, right);
  const diceCoefficient = getDiceCoefficient(compactLeft, compactRight);

  return boundaryCoverage * 0.5 + diceCoefficient * 0.35 + Math.max(subsequenceCoverage, tokenCoverage) * 0.15;
};

const getBestAliasSimilarity = (input: string, aliases: string[]): number =>
  aliases.reduce((best, alias) => Math.max(best, getTextSimilarity(input, alias)), 0);

const resolveUniqueBestMatch = <T>(
  items: T[],
  scoreSelector: (item: T) => number,
  idSelector: (item: T) => string,
): AutoMatchResolution => {
  const ranked = items
    .map((item) => ({
      canonicalSalesUnitId: idSelector(item),
      score: scoreSelector(item),
    }))
    .filter((item) => item.score >= AUTO_MATCH_MIN_SCORE)
    .sort((left, right) => right.score - left.score);

  if (!ranked.length) {
    return {
      canonicalSalesUnitId: null,
      candidateCount: 0,
      ambiguous: false,
    };
  }

  const best = ranked[0];
  const competingCount = ranked.filter((item) => best.score - item.score < AUTO_MATCH_MIN_MARGIN).length;
  if (competingCount > 1) {
    return {
      canonicalSalesUnitId: null,
      candidateCount: competingCount,
      ambiguous: true,
    };
  }

  return {
    canonicalSalesUnitId: best.canonicalSalesUnitId,
    candidateCount: 1,
    ambiguous: false,
  };
};

const getOrderSalesUnitScore = (signature: OrderSourceSignature, salesUnit: CanonicalSalesUnit): number => {
  const productAliases = [salesUnit.normalizedStandardProductName, salesUnit.normalizedDisplayName].filter(Boolean);
  const productScore = getBestAliasSimilarity(signature.normalizedProductName, productAliases);
  const fullSignatureScore = getBestAliasSimilarity(signature.sourceSignature, [
    createSourceSignature(salesUnit.standardProductName, salesUnit.standardOptionName),
    salesUnit.normalizedDisplayName,
  ]);

  if (!salesUnit.normalizedStandardOptionName) {
    return Math.max(productScore, fullSignatureScore * 0.98);
  }

  const optionScore = getBestAliasSimilarity(signature.normalizedOptionInfo, [salesUnit.normalizedStandardOptionName]);
  return Math.max(productScore * 0.82 + optionScore * 0.18, fullSignatureScore * 0.99);
};

const getCampaignSalesUnitScore = (normalizedCampaignName: string, salesUnit: CanonicalSalesUnit): number =>
  getBestAliasSimilarity(normalizedCampaignName, [
    salesUnit.normalizedDisplayName,
    salesUnit.normalizedStandardProductName,
    createSourceSignature(salesUnit.standardProductName, salesUnit.standardOptionName).replace(" || ", " "),
  ]);

export const getActiveSalesUnitsForAutoMapping = (
  database: Pick<DatabaseShape, "canonicalSalesUnits">,
  storeId: string,
): CanonicalSalesUnit[] =>
  database.canonicalSalesUnits.filter((item) => item.storeId === storeId && item.isActive);

export const resolveOrderSignatureAutoMapping = (
  salesUnits: CanonicalSalesUnit[],
  signature: OrderSourceSignature,
): AutoMatchResolution =>
  resolveUniqueBestMatch(salesUnits, (salesUnit) => getOrderSalesUnitScore(signature, salesUnit), (salesUnit) => salesUnit.id);

export const resolveCampaignAutoMapping = (
  salesUnits: CanonicalSalesUnit[],
  normalizedCampaignName: string,
): AutoMatchResolution =>
  resolveUniqueBestMatch(
    salesUnits,
    (salesUnit) => getCampaignSalesUnitScore(normalizedCampaignName, salesUnit),
    (salesUnit) => salesUnit.id,
  );

export const recalculateOrderMappingsForStore = (database: DatabaseShape, storeId: string): void => {
  const autoMatchSalesUnits = getActiveSalesUnitsForAutoMapping(database, storeId);
  const signaturesById = new Map<string, OrderSourceSignature>();

  database.orderSourceSignatures
    .filter((item) => item.storeId === storeId)
    .forEach((signature) => {
      if (!signature.confirmedAt) {
        const nextCanonicalSalesUnitId = resolveOrderSignatureAutoMapping(autoMatchSalesUnits, signature).canonicalSalesUnitId;
        if (signature.canonicalSalesUnitId !== nextCanonicalSalesUnitId) {
          signature.canonicalSalesUnitId = nextCanonicalSalesUnitId;
          signature.updatedAt = nowIso();
        }
      }

      signaturesById.set(signature.id, signature);
    });

  const salesUnitsById = new Map(
    database.canonicalSalesUnits.filter((item) => item.storeId === storeId).map((item) => [item.id, item]),
  );

  database.orderItems
    .filter((item) => item.storeId === storeId)
    .forEach((item) => {
      const signature = item.orderSourceSignatureId ? signaturesById.get(item.orderSourceSignatureId) : null;
      const candidate = signature?.canonicalSalesUnitId ? salesUnitsById.get(signature.canonicalSalesUnitId) : null;
      item.canonicalSalesUnitId =
        candidate && isSalesUnitAssignable(candidate.deactivatedAt, item.paymentDate) ? candidate.id : null;
      item.updatedAt = nowIso();
    });
};

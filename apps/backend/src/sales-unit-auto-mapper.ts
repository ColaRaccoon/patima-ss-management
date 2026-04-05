import {
  CanonicalSalesUnit,
  DatabaseShape,
  normalizeMatchAlias,
  OrderSourceSignature,
} from "@patima/shared";
import { getSignatureMappingStatus, isSalesUnitAssignable, nowIso } from "./helpers";

interface AutoMatchResolution {
  canonicalSalesUnitId: string | null;
  candidateCount: number;
  ambiguous: boolean;
}

const dedupe = (values: Array<string | null | undefined>): string[] =>
  Array.from(new Set(values.filter((value): value is string => Boolean(value))));

const matchesAlias = (lookupValues: string[], alias: string): boolean =>
  alias.length > 0 && lookupValues.some((value) => value.includes(alias));

const resolveAliasMatches = (
  salesUnits: CanonicalSalesUnit[],
  lookupValues: string[],
): AutoMatchResolution => {
  const matched = salesUnits.filter((salesUnit) =>
    (salesUnit.normalizedMatchAliases ?? []).some((alias) => matchesAlias(lookupValues, alias)),
  );

  if (matched.length === 1) {
    return {
      canonicalSalesUnitId: matched[0].id,
      candidateCount: 1,
      ambiguous: false,
    };
  }

  if (matched.length > 1) {
    return {
      canonicalSalesUnitId: null,
      candidateCount: matched.length,
      ambiguous: true,
    };
  }

  return {
    canonicalSalesUnitId: null,
    candidateCount: 0,
    ambiguous: false,
  };
};

const buildOrderLookupValues = (signature: OrderSourceSignature): string[] =>
  dedupe([
    normalizeMatchAlias(signature.normalizedProductName),
    normalizeMatchAlias(signature.normalizedOptionInfo),
    normalizeMatchAlias(signature.sourceSignature),
    normalizeMatchAlias(`${signature.normalizedProductName} ${signature.normalizedOptionInfo}`),
  ]);

const buildCampaignLookupValues = (normalizedCampaignName: string): string[] =>
  dedupe([normalizeMatchAlias(normalizedCampaignName)]);

export const getActiveSalesUnitsForAutoMapping = (
  database: Pick<DatabaseShape, "canonicalSalesUnits">,
  storeId: string,
): CanonicalSalesUnit[] =>
  database.canonicalSalesUnits.filter(
    (item) => item.storeId === storeId && item.isActive && (item.normalizedMatchAliases ?? []).length > 0,
  );

export const resolveOrderSignatureAutoMapping = (
  salesUnits: CanonicalSalesUnit[],
  signature: OrderSourceSignature,
): AutoMatchResolution => resolveAliasMatches(salesUnits, buildOrderLookupValues(signature));

export const resolveCampaignAutoMapping = (
  salesUnits: CanonicalSalesUnit[],
  normalizedCampaignName: string,
): AutoMatchResolution => resolveAliasMatches(salesUnits, buildCampaignLookupValues(normalizedCampaignName));

export const recalculateOrderMappingsForStore = (database: DatabaseShape, storeId: string): void => {
  const autoMatchSalesUnits = getActiveSalesUnitsForAutoMapping(database, storeId);
  const signaturesById = new Map<string, OrderSourceSignature>();

  database.orderSourceSignatures
    .filter((item) => item.storeId === storeId)
    .forEach((signature) => {
      if (!signature.confirmedAt) {
        const resolution = resolveOrderSignatureAutoMapping(autoMatchSalesUnits, signature);
        const nextMappingStatus = resolution.ambiguous
          ? "CONFLICT"
          : resolution.canonicalSalesUnitId
            ? "MAPPED"
            : "UNMAPPED";
        if (
          signature.canonicalSalesUnitId !== resolution.canonicalSalesUnitId ||
          signature.mappingStatus !== nextMappingStatus
        ) {
          signature.canonicalSalesUnitId = resolution.canonicalSalesUnitId;
          signature.mappingStatus = nextMappingStatus;
          signature.updatedAt = nowIso();
        }
      } else {
        const nextMappingStatus = getSignatureMappingStatus(signature);
        if (signature.mappingStatus !== nextMappingStatus) {
          signature.mappingStatus = nextMappingStatus;
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
      const signatureStatus = signature ? getSignatureMappingStatus(signature) : item.canonicalSalesUnitId ? "MAPPED" : "UNMAPPED";
      const candidate =
        signatureStatus === "MAPPED" && signature?.canonicalSalesUnitId
          ? salesUnitsById.get(signature.canonicalSalesUnitId)
          : null;

      item.canonicalSalesUnitId =
        candidate && isSalesUnitAssignable(candidate.deactivatedAt, item.paymentDate) ? candidate.id : null;
      item.updatedAt = nowIso();
    });
};

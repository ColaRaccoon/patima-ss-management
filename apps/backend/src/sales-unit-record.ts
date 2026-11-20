import { BadRequestException } from "@nestjs/common";
import { CanonicalSalesUnit, normalizeText } from "@patima/shared";
import { assertGroupInvariants, ensureNormalizedLength, normalizeMatchAliasList, sanitizeMatchAliases } from "./helpers";

export function buildSalesUnitRecord(params: {
  id: string;
  storeId: string;
  displayName: string;
  matchAliases?: string[] | null;
  linkedProductIds?: string[] | null;
  linkedOptionCodes?: string[] | null;
  linkedManageCodes?: string[] | null;
  memo?: string | null;
  parentSalesUnitId?: string | null;
  isGroup?: boolean;
  timestamp: string;
}): CanonicalSalesUnit {
  const displayName = params.displayName.trim();
  ensureNormalizedLength(normalizeText(displayName), "displayName");
  const matchAliases = sanitizeMatchAliases(params.matchAliases ?? []);
  const record: CanonicalSalesUnit = {
    id: params.id,
    storeId: params.storeId,
    displayName,
    matchAliases,
    normalizedMatchAliases: normalizeMatchAliasList(matchAliases),
    linkedProductIds: params.linkedProductIds ?? [],
    linkedOptionCodes: params.linkedOptionCodes ?? [],
    linkedManageCodes: params.linkedManageCodes ?? [],
    memo: params.memo ?? null,
    isActive: true,
    deactivatedAt: null,
    isStoreLevel: false,
    parentSalesUnitId: params.parentSalesUnitId ?? null,
    isGroup: params.isGroup ?? false,
    createdAt: params.timestamp,
    updatedAt: params.timestamp,
  };
  assertGroupInvariants(record);
  return record;
}

export function ensureUniqueSalesUnit(
  existing: CanonicalSalesUnit[],
  target: CanonicalSalesUnit,
  excludeId?: string,
) {
  const comparable = existing.filter((item) => item.id !== excludeId && item.storeId === target.storeId);
  const normalizedName = normalizeText(target.displayName);
  if (comparable.some((item) => normalizeText(item.displayName) === normalizedName)) {
    throw new BadRequestException({
      success: false,
      message: `이미 사용 중인 판매단위 이름입니다. (${target.displayName})`,
      errors: [{ field: "displayName", reason: "SALES_UNIT_DUPLICATE_DISPLAY_NAME" }],
    });
  }

  const duplicatedAlias = target.normalizedMatchAliases.find((alias) =>
    comparable.some((item) => item.normalizedMatchAliases.includes(alias)),
  );
  if (duplicatedAlias) {
    throw new BadRequestException({
      success: false,
      message: `이미 사용 중인 자동 매핑 키워드입니다. (${duplicatedAlias})`,
      errors: [{ field: "matchAliases", reason: "SALES_UNIT_DUPLICATE_MATCH_ALIAS" }],
    });
  }
}

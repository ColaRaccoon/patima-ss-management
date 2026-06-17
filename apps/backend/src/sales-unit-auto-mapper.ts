import {
  CanonicalSalesUnit,
  DatabaseShape,
  normalizeMatchAlias,
  OrderSourceSignature,
  OrderItem,
} from "@patima/shared";
import { coalesceNonBlankText, getSignatureMappingStatus, isSalesUnitAssignable, nowIso } from "./helpers";

interface AutoMatchResolution {
  canonicalSalesUnitId: string | null;
  candidateCount: number;
  ambiguous: boolean;
}

interface ItemIdMappingResult {
  resolvedUnitId: string | null;
  resolvedBy: "optionManageCode" | "optionCode" | "productId" | "fallback" | null;
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

function resolveByOptionManageCode(
  salesUnits: CanonicalSalesUnit[],
  optionManageCode: string | null | undefined,
): string | null {
  if (!optionManageCode) return null;
  const matched = salesUnits.find((u) => u.linkedManageCodes?.includes(optionManageCode));
  return matched?.id ?? null;
}

function resolveByOptionCode(
  salesUnits: CanonicalSalesUnit[],
  optionCode: string | null,
): string | null {
  if (!optionCode) return null;
  const matched = salesUnits.find((u) => u.linkedOptionCodes?.includes(optionCode));
  return matched?.id ?? null;
}

function resolveByProductId(
  salesUnits: CanonicalSalesUnit[],
  externalProductId: string | null,
): string | null {
  if (!externalProductId) return null;
  const matched = salesUnits.find((u) => u.linkedProductIds?.includes(externalProductId));
  return matched?.id ?? null;
}

export const getActiveSalesUnitsForAutoMapping = (
  database: Pick<DatabaseShape, "canonicalSalesUnits">,
  storeId: string,
): CanonicalSalesUnit[] =>
  database.canonicalSalesUnits.filter(
    (item) => item.storeId === storeId && item.isActive && !item.isGroup && (item.normalizedMatchAliases ?? []).length > 0,
  );

export const getActiveSalesUnitsForIdMapping = (
  database: Pick<DatabaseShape, "canonicalSalesUnits">,
  storeId: string,
): CanonicalSalesUnit[] =>
  database.canonicalSalesUnits.filter(
    (item) =>
      item.storeId === storeId &&
      item.isActive &&
      ((item.linkedOptionCodes ?? []).length > 0 || (item.linkedProductIds ?? []).length > 0 || (item.linkedManageCodes ?? []).length > 0),
  );

export const resolveOrderSignatureAutoMapping = (
  salesUnits: CanonicalSalesUnit[],
  signature: OrderSourceSignature,
): AutoMatchResolution => resolveAliasMatches(salesUnits, buildOrderLookupValues(signature));

export const resolveCampaignAutoMapping = (
  salesUnits: CanonicalSalesUnit[],
  normalizedCampaignName: string,
): AutoMatchResolution => resolveAliasMatches(salesUnits, buildCampaignLookupValues(normalizedCampaignName));

export const resolveOrderItemByIds = (
  salesUnits: CanonicalSalesUnit[],
  item: OrderItem,
  optionManageCode?: string,
): ItemIdMappingResult => {
  // 1순위: optionManageCode → linkedManageCodes (함께배송 관리코드)
  if (optionManageCode) {
    const resolvedByManageCode = resolveByOptionManageCode(salesUnits, optionManageCode);
    if (resolvedByManageCode) {
      return {
        resolvedUnitId: resolvedByManageCode,
        resolvedBy: "optionManageCode",
      };
    }
  }

  // 2순위: optionCode → linkedOptionCodes (함께배송 옵션코드 폴백)
  const resolvedByOptionCode = resolveByOptionCode(salesUnits, item.optionCode);
  if (resolvedByOptionCode) {
    return {
      resolvedUnitId: resolvedByOptionCode,
      resolvedBy: "optionCode",
    };
  }

  // 3순위: externalProductId → linkedProductIds (일반 상품)
  const resolvedByProductId = resolveByProductId(salesUnits, item.externalProductId);
  if (resolvedByProductId) {
    return {
      resolvedUnitId: resolvedByProductId,
      resolvedBy: "productId",
    };
  }

  // 4순위: fallback (텍스트 매칭은 시그니처 기반으로 진행, 여기서는 null 반환)
  return {
    resolvedUnitId: null,
    resolvedBy: null,
  };
};

const buildIdMappingMaps = (salesUnits: CanonicalSalesUnit[]) => {
  const manageCodeMap = new Map<string, string>();
  const optionCodeMap = new Map<string, string>();
  const productIdMap = new Map<string, string>();

  salesUnits.forEach((unit) => {
    (unit.linkedManageCodes ?? []).forEach((code) => manageCodeMap.set(code, unit.id));
    (unit.linkedOptionCodes ?? []).forEach((code) => optionCodeMap.set(code, unit.id));
    (unit.linkedProductIds ?? []).forEach((id) => productIdMap.set(id, unit.id));
  });

  return { manageCodeMap, optionCodeMap, productIdMap };
};

const recalculateOrderMappings = (
  database: DatabaseShape,
  storeId: string,
  options?: {
    signatureIds?: Set<string> | string[] | null;
    orderItemIds?: Set<string> | string[] | null;
  },
): void => {
  const autoMatchSalesUnits = getActiveSalesUnitsForAutoMapping(database, storeId);
  const idMappingSalesUnits = getActiveSalesUnitsForIdMapping(database, storeId);
  const targetSignatureIds = options?.signatureIds
    ? new Set(Array.from(options.signatureIds).filter(Boolean))
    : null;
  const targetOrderItemIds = options?.orderItemIds
    ? new Set(Array.from(options.orderItemIds).filter(Boolean))
    : null;

  database.orderSourceSignatures
    .filter((item) => item.storeId === storeId && (!targetSignatureIds || targetSignatureIds.has(item.id)))
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
          signature.lastAutoMappedAt = nowIso();
          signature.updatedAt = nowIso();
        }
      } else {
        const nextMappingStatus = getSignatureMappingStatus(signature);
        if (signature.mappingStatus !== nextMappingStatus) {
          signature.mappingStatus = nextMappingStatus;
          signature.updatedAt = nowIso();
        }
      }
    });

  const signaturesById = new Map<string, OrderSourceSignature>(
    database.orderSourceSignatures
      .filter((item) => item.storeId === storeId)
      .map((signature) => [signature.id, signature]),
  );

  const salesUnitsById = new Map(
    database.canonicalSalesUnits.filter((item) => item.storeId === storeId).map((item) => [item.id, item]),
  );

  const { manageCodeMap, optionCodeMap, productIdMap } = buildIdMappingMaps(idMappingSalesUnits);

  // ──────────────────────────────────────────────
  // Phase 2: 주문 아이템 ID 기반 매핑
  // ──────────────────────────────────────────────

  database.orderItems
    .filter((item) => item.storeId === storeId && (!targetOrderItemIds || targetOrderItemIds.has(item.id)))
    .forEach((item) => {
      const signature = item.orderSourceSignatureId ? signaturesById.get(item.orderSourceSignatureId) : null;
      const signatureHasConfirmedMapping = signature?.confirmedAt !== undefined && signature?.confirmedAt !== null;

      let resolvedUnitId: string | null = null;
      let mappingMethod: string | null = null;

      // 우선순위 1: confirmedAt 있는 매핑은 항상 존중
      if (signatureHasConfirmedMapping && signature?.canonicalSalesUnitId) {
        resolvedUnitId = signature.canonicalSalesUnitId;
        mappingMethod = "signature-confirmed";
      } else {
        const rawOptionInfo = coalesceNonBlankText(signature?.rawOptionInfoSnapshot, item.rawOptionInfo);
        // 함께배송 아이템인지 판별 (signature snapshot 우선, legacy item fallback)
        const isBundledItem = rawOptionInfo?.includes("[함께배송") ?? false;

        // 우선순위 2: ID 매핑 시도 (optionManageCode → linkedManageCodes)
        if (isBundledItem && item.optionManageCode) {
          const resolvedId = manageCodeMap.get(item.optionManageCode);
          if (resolvedId) {
            resolvedUnitId = resolvedId;
            mappingMethod = "optionManageCode";
          }
        }

        // 우선순위 3: ID 매핑 시도 (optionCode → linkedOptionCodes)
        if (!resolvedUnitId && item.optionCode) {
          const resolvedId = optionCodeMap.get(item.optionCode);
          if (resolvedId) {
            resolvedUnitId = resolvedId;
            mappingMethod = "optionCode";
          }
        }

        // 우선순위 4: ID 매핑 시도 (externalProductId → linkedProductIds)
        // ⚠️ 함께배송 아이템은 메인 상품과 같은 externalProductId를 공유하므로
        //    productId fallback을 사용하면 메인 상품에 잘못 매핑됨 → 함께배송은 건너뜀
        if (!resolvedUnitId && item.externalProductId && !isBundledItem) {
          const resolvedId = productIdMap.get(item.externalProductId);
          if (resolvedId) {
            resolvedUnitId = resolvedId;
            mappingMethod = "productId";
          }
        }

        // 우선순위 5: 기존 시그니처 기반 텍스트 매칭 (fallback)
        if (!resolvedUnitId && signature) {
          const signatureStatus = getSignatureMappingStatus(signature);
          if (signatureStatus === "MAPPED" && signature.canonicalSalesUnitId) {
            const sigUnit = salesUnitsById.get(signature.canonicalSalesUnitId);
            if (sigUnit?.isActive) {
              resolvedUnitId = signature.canonicalSalesUnitId;
              mappingMethod = "text-fallback";
            }
          }
        }
      }

      // 매핑 방식 디버그 로그 (debug 레벨)
      if (mappingMethod) {
        console.debug(`[AutoMapper] Item ${item.externalProductOrderId}: resolved via ${mappingMethod}`);
      }

      // 비활성화 판매단위 검사 및 할당 가능 여부 확인
      let finalUnitId: string | null = null;
      if (resolvedUnitId) {
        const candidate = salesUnitsById.get(resolvedUnitId);
        if (candidate && isSalesUnitAssignable(candidate.deactivatedAt, item.paymentDate)) {
          finalUnitId = resolvedUnitId;
        }
      }

      // 변경사항이 있으면 업데이트
      if (item.canonicalSalesUnitId !== finalUnitId) {
        item.canonicalSalesUnitId = finalUnitId;
        item.updatedAt = nowIso();
      }

    });

  // ──────────────────────────────────────────────
  // Phase 3: 시그니처 역추론 — 아이템 ID 매핑 결과로 시그니처 자동 매핑
  //          같은 시그니처에 속한 아이템들이 모두 동일한 salesUnit이면 시그니처도 매핑
  // ──────────────────────────────────────────────
  const inferenceSignatureIds = targetSignatureIds ?? new Set(signaturesById.keys());
  const signatureItemMappings = new Map<string, Set<string>>();
  database.orderItems
    .filter(
      (item) =>
        item.storeId === storeId &&
        item.orderSourceSignatureId &&
        inferenceSignatureIds.has(item.orderSourceSignatureId) &&
        item.canonicalSalesUnitId,
    )
    .forEach((item) => {
      const signatureId = item.orderSourceSignatureId!;
      const unitIds = signatureItemMappings.get(signatureId) ?? new Set<string>();
      unitIds.add(item.canonicalSalesUnitId!);
      signatureItemMappings.set(signatureId, unitIds);
    });

  signatureItemMappings.forEach((unitIds, signatureId) => {
    const signature = signaturesById.get(signatureId);
    if (!signature || signature.confirmedAt) return; // 수동 확인된 건 건드리지 않음

    if (unitIds.size === 1) {
      // 모든 아이템이 같은 salesUnit으로 매핑됨 → 시그니처도 매핑
      const resolvedUnitId = Array.from(unitIds)[0];
      if (signature.canonicalSalesUnitId !== resolvedUnitId || signature.mappingStatus !== "MAPPED") {
        signature.canonicalSalesUnitId = resolvedUnitId;
        signature.mappingStatus = "MAPPED";
        signature.lastAutoMappedAt = nowIso();
        signature.updatedAt = nowIso();
        console.log(`[AutoMapper] Signature ${signatureId}: inferred from item ID mapping → ${resolvedUnitId}`);
      }
    } else if (unitIds.size > 1) {
      // 아이템들이 서로 다른 salesUnit으로 매핑됨 → CONFLICT
      if (signature.mappingStatus !== "CONFLICT") {
        signature.canonicalSalesUnitId = null;
        signature.mappingStatus = "CONFLICT";
        signature.lastAutoMappedAt = nowIso();
        signature.updatedAt = nowIso();
        console.log(`[AutoMapper] Signature ${signatureId}: item ID mapping conflict (${unitIds.size} different units)`);
      }
    }
  });
};

export const recalculateOrderMappingsForStore = (database: DatabaseShape, storeId: string): void => {
  recalculateOrderMappings(database, storeId);
};

export const recalculateOrderMappingsForTouchedItems = (
  database: DatabaseShape,
  params: {
    storeId: string;
    signatureIds: Set<string> | string[];
    orderItemIds: Set<string> | string[];
  },
): void => {
  recalculateOrderMappings(database, params.storeId, {
    signatureIds: params.signatureIds,
    orderItemIds: params.orderItemIds,
  });
};

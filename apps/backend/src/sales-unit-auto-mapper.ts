import {
  CanonicalSalesUnit,
  DatabaseShape,
  normalizeMatchAlias,
  OrderSourceSignature,
  OrderItem,
} from "@patima/shared";
import {
  coalesceNonBlankText,
  getSignatureMappingStatus,
  isSalesUnitAssignable,
  nowIso,
} from "./helpers";
import {
  createOrderGroupContext,
  matchOrderGroup,
  matchesOrderAlias,
  OrderGroupMatch,
} from "./order-group-matcher";

interface AutoMatchResolution {
  canonicalSalesUnitId: string | null;
  candidateCount: number;
  ambiguous: boolean;
}

interface ItemIdMappingResult {
  resolvedUnitId: string | null;
  resolvedBy:
    | "optionManageCode"
    | "optionCode"
    | "productId"
    | "fallback"
    | null;
  ambiguous?: boolean;
}

const dedupe = (values: Array<string | null | undefined>): string[] =>
  Array.from(
    new Set(values.filter((value): value is string => Boolean(value))),
  );

const matchesAlias = (lookupValues: string[], alias: string): boolean =>
  alias.length > 0 && lookupValues.some((value) => value.includes(alias));

const resolveAliasMatches = (
  salesUnits: CanonicalSalesUnit[],
  lookupValues: string[],
): AutoMatchResolution => {
  const matched = salesUnits.filter((salesUnit) =>
    (salesUnit.normalizedMatchAliases ?? []).some((alias) =>
      matchesAlias(lookupValues, alias),
    ),
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

const buildCampaignLookupValues = (normalizedCampaignName: string): string[] =>
  dedupe([normalizeMatchAlias(normalizedCampaignName)]);

export const getActiveSalesUnitsForAutoMapping = (
  database: Pick<DatabaseShape, "canonicalSalesUnits">,
  storeId: string,
): CanonicalSalesUnit[] =>
  database.canonicalSalesUnits.filter(
    (item) =>
      item.storeId === storeId &&
      item.isActive &&
      !item.isGroup &&
      !item.isStoreLevel &&
      (!item.parentSalesUnitId ||
        database.canonicalSalesUnits.some(
          (parent) =>
            parent.id === item.parentSalesUnitId &&
            parent.storeId === storeId &&
            parent.isActive,
        )) &&
      (item.normalizedMatchAliases ?? []).length > 0,
  );

// 광고는 그룹에 귀속된다. 부모와 자식의 키워드가 함께 일치해도
// 같은 광고 귀속 대상이면 후보 하나로 취급한다. 주문 매핑은 기존 정책을 유지한다.
export const getActiveSalesUnitsForCampaignMapping = (
  database: Pick<DatabaseShape, "canonicalSalesUnits">,
  storeId: string,
): CanonicalSalesUnit[] => {
  const activeUnits = database.canonicalSalesUnits.filter(
    (unit) => unit.storeId === storeId && unit.isActive,
  );
  const unitsById = new Map(activeUnits.map((unit) => [unit.id, unit]));
  const targets = new Map<string, CanonicalSalesUnit>();
  for (const unit of activeUnits) {
    const target = unitsById.get(unit.parentSalesUnitId ?? unit.id);
    if (!target || !unit.normalizedMatchAliases?.length) continue;
    const existing = targets.get(target.id);
    targets.set(target.id, {
      ...target,
      normalizedMatchAliases: Array.from(
        new Set([
          ...(existing?.normalizedMatchAliases ?? []),
          ...unit.normalizedMatchAliases,
        ]),
      ),
    });
  }
  return Array.from(targets.values());
};

export const getActiveSalesUnitsForIdMapping = (
  database: Pick<DatabaseShape, "canonicalSalesUnits">,
  storeId: string,
): CanonicalSalesUnit[] =>
  database.canonicalSalesUnits.filter(
    (item) =>
      item.storeId === storeId &&
      item.isActive &&
      !item.isGroup &&
      !item.isStoreLevel &&
      (!item.parentSalesUnitId ||
        database.canonicalSalesUnits.some(
          (parent) =>
            parent.id === item.parentSalesUnitId &&
            parent.storeId === storeId &&
            parent.isActive,
        )) &&
      ((item.linkedOptionCodes ?? []).length > 0 ||
        (item.linkedProductIds ?? []).length > 0 ||
        (item.linkedManageCodes ?? []).length > 0),
  );

export const resolveOrderSignatureAutoMapping = (
  salesUnits: CanonicalSalesUnit[],
  signature: OrderSourceSignature,
): AutoMatchResolution => {
  const option = coalesceNonBlankText(
    signature.rawOptionInfoSnapshot,
    signature.normalizedOptionInfo,
  ) ?? "";
  const product = /\[함께배송/.test(option)
    ? ""
    : signature.normalizedProductName;
  const matched = salesUnits.filter((unit) =>
    (unit.normalizedMatchAliases ?? []).some((alias) =>
      matchesOrderAlias(unit, alias, product, option),
    ),
  );
  return {
    canonicalSalesUnitId: matched.length === 1 ? matched[0].id : null,
    candidateCount: matched.length,
    ambiguous: matched.length > 1,
  };
};

export const resolveCampaignAutoMapping = (
  salesUnits: CanonicalSalesUnit[],
  normalizedCampaignName: string,
): AutoMatchResolution =>
  resolveAliasMatches(
    salesUnits,
    buildCampaignLookupValues(normalizedCampaignName),
  );

type IdMappingMaps = Record<
  "optionManageCode" | "optionCode" | "productId",
  Map<string, Set<string>>
>;

const buildIdMappingMaps = (
  salesUnits: CanonicalSalesUnit[],
): IdMappingMaps => {
  const maps: IdMappingMaps = {
    optionManageCode: new Map(),
    optionCode: new Map(),
    productId: new Map(),
  };
  for (const unit of salesUnits) {
    if (!unit.isActive || unit.isGroup || unit.isStoreLevel) continue;
    for (const [kind, values] of [
      ["optionManageCode", unit.linkedManageCodes],
      ["optionCode", unit.linkedOptionCodes],
      ["productId", unit.linkedProductIds],
    ] as const) {
      for (const value of values ?? []) {
        const key = value.trim();
        if (!key) continue;
        const ids = maps[kind].get(key) ?? new Set<string>();
        ids.add(unit.id);
        maps[kind].set(key, ids);
      }
    }
  }
  return maps;
};

const resolveWithIdMaps = (
  maps: IdMappingMaps,
  item: OrderItem,
  bundled: boolean,
  group: OrderGroupMatch | null,
): ItemIdMappingResult => {
  const keys = [
    ["optionManageCode", item.optionManageCode],
    ["optionCode", item.optionCode],
    ["productId", bundled ? null : item.externalProductId],
  ] as const;
  for (const [kind, key] of keys) {
    const candidates = key ? maps[kind].get(key.trim()) : undefined;
    if (!candidates?.size) continue;
    let ids = [...candidates];
    if (group) {
      ids = ids.filter((id) => group.familyUnitIds.has(id));
      // A listing ID may name the main product while the selected option names another family.
      if (!ids.length && kind === "productId") continue;
      if (!ids.length)
        return { resolvedUnitId: null, resolvedBy: kind, ambiguous: true };
      if (kind === "productId" || ids.length > 1)
        ids = ids.filter((id) => group.candidateIds.has(id));
    }
    if (ids.length === 1) return { resolvedUnitId: ids[0], resolvedBy: kind };
    return { resolvedUnitId: null, resolvedBy: kind, ambiguous: true };
  }
  return { resolvedUnitId: null, resolvedBy: null };
};

export const resolveOrderItemByIds = (
  salesUnits: CanonicalSalesUnit[],
  item: OrderItem,
  optionManageCode?: string,
): ItemIdMappingResult =>
  resolveWithIdMaps(
    buildIdMappingMaps(
      salesUnits.filter((unit) => unit.storeId === item.storeId),
    ),
    { ...item, optionManageCode: optionManageCode ?? item.optionManageCode },
    /\[함께배송/.test(item.rawOptionInfo ?? ""),
    null,
  );

const recalculateOrderMappings = (
  database: DatabaseShape,
  storeId: string,
  options?: {
    signatureIds?: Set<string> | string[] | null;
    orderItemIds?: Set<string> | string[] | null;
  },
): void => {
  const autoMatchSalesUnits = getActiveSalesUnitsForAutoMapping(
    database,
    storeId,
  );
  const groupContext = createOrderGroupContext(database, storeId);
  const idMaps = buildIdMappingMaps(
    getActiveSalesUnitsForIdMapping(database, storeId),
  );
  const targetSignatureIds = options?.signatureIds
    ? new Set(Array.from(options.signatureIds).filter(Boolean))
    : null;
  const targetOrderItemIds = options?.orderItemIds
    ? new Set(Array.from(options.orderItemIds).filter(Boolean))
    : null;
  const signaturesById = new Map(
    database.orderSourceSignatures
      .filter((signature) => signature.storeId === storeId)
      .map((signature) => [signature.id, signature]),
  );
  const salesUnitsById = new Map(
    database.canonicalSalesUnits
      .filter((unit) => unit.storeId === storeId)
      .map((unit) => [unit.id, unit]),
  );
  const groupsBySignature = new Map<string, OrderGroupMatch | null>();
  const ambiguousSignatures = new Set<string>();
  const blockedItems = new Set<string>();
  const blockedSignatures = new Set<string>();
  const idResolvedSignatures = new Set<string>();
  const touchedItems = database.orderItems.filter(
    (item) =>
      item.storeId === storeId &&
      (!targetOrderItemIds || targetOrderItemIds.has(item.id)),
  );
  const timestamp = nowIso();
  const setSignature = (
    signature: OrderSourceSignature,
    unitId: string | null,
    status: "MAPPED" | "UNMAPPED" | "CONFLICT",
  ) => {
    if (
      signature.canonicalSalesUnitId === unitId &&
      signature.mappingStatus === status
    )
      return;
    signature.canonicalSalesUnitId = unitId;
    signature.mappingStatus = status;
    signature.lastAutoMappedAt = timestamp;
    signature.updatedAt = timestamp;
  };
  const assignable = (unitId: string, item: OrderItem): boolean => {
    const unit = salesUnitsById.get(unitId);
    if (
      !unit ||
      unit.isGroup ||
      unit.isStoreLevel ||
      (!unit.isActive && !unit.deactivatedAt) ||
      !isSalesUnitAssignable(unit.deactivatedAt, item.paymentDate)
    )
      return false;
    const parent = unit.parentSalesUnitId
      ? salesUnitsById.get(unit.parentSalesUnitId)
      : null;
    return (
      !unit.parentSalesUnitId ||
      (!!parent &&
        (parent.isActive || !!parent.deactivatedAt) &&
        isSalesUnitAssignable(parent.deactivatedAt, item.paymentDate))
    );
  };
  const setItem = (item: OrderItem, unitId: string | null) => {
    const target = unitId && assignable(unitId, item) ? unitId : null;
    if (item.canonicalSalesUnitId !== target) {
      item.canonicalSalesUnitId = target;
      item.updatedAt = timestamp;
    }
  };

  for (const signature of signaturesById.values()) {
    if (targetSignatureIds && !targetSignatureIds.has(signature.id)) continue;
    if (signature.confirmedAt && signature.canonicalSalesUnitId) continue;
    if (signature.confirmedAt && !signature.canonicalSalesUnitId)
      signature.confirmedAt = null;
    let group = matchOrderGroup(groupContext, signature);
    let resolution = resolveOrderSignatureAutoMapping(
      autoMatchSalesUnits,
      signature,
    );
    if (group) {
      const option =
        coalesceNonBlankText(
          signature.rawOptionInfoSnapshot,
          signature.normalizedOptionInfo,
        ) ?? "";
      const scopedDirect =
        group.matchSource === "option" && group.optionOverridesProduct
          ? resolveOrderSignatureAutoMapping(autoMatchSalesUnits, {
              ...signature,
              normalizedProductName: "",
              normalizedOptionInfo: option,
              sourceSignature: option,
            })
          : resolution;
      // A configured leaf keyword is a direct rule. Broad family keywords must not steal it.
      if (
        scopedDirect.canonicalSalesUnitId &&
        !group.familyUnitIds.has(scopedDirect.canonicalSalesUnitId)
      ) {
        resolution = scopedDirect;
        group = null;
      }
    }
    groupsBySignature.set(signature.id, group);
    if (group) {
      const candidate =
        group.candidateIds.size === 1 && group.groupIds.size === 1
          ? [...group.candidateIds][0]
          : null;
      const target = candidate ? salesUnitsById.get(candidate) : null;
      resolution = {
        canonicalSalesUnitId: target?.isActive ? target.id : null,
        candidateCount: group.candidateIds.size,
        ambiguous: group.groupIds.size > 1 || group.candidateIds.size > 1,
      };
    }
    if (resolution.ambiguous) ambiguousSignatures.add(signature.id);
    setSignature(
      signature,
      resolution.canonicalSalesUnitId,
      resolution.ambiguous
        ? "CONFLICT"
        : resolution.canonicalSalesUnitId
          ? "MAPPED"
          : "UNMAPPED",
    );
  }

  for (const item of touchedItems) {
    const signature = item.orderSourceSignatureId
      ? signaturesById.get(item.orderSourceSignatureId)
      : undefined;
    if (signature?.confirmedAt && signature.canonicalSalesUnitId) {
      setItem(item, signature.canonicalSalesUnitId);
      continue;
    }
    const option = coalesceNonBlankText(
      signature?.rawOptionInfoSnapshot,
      item.rawOptionInfo,
    );
    const group = signature
      ? groupsBySignature.has(signature.id)
        ? groupsBySignature.get(signature.id)!
        : matchOrderGroup(groupContext, signature)
      : null;
    const ids = resolveWithIdMaps(
      idMaps,
      item,
      /\[함께배송/.test(option ?? ""),
      group,
    );
    if (ids.ambiguous) {
      blockedItems.add(item.id);
      if (signature) blockedSignatures.add(signature.id);
      setItem(item, null);
      continue;
    }
    if (ids.resolvedUnitId && signature) idResolvedSignatures.add(signature.id);
    let target = ids.resolvedUnitId;
    if (
      !target &&
      signature &&
      getSignatureMappingStatus(signature) === "MAPPED"
    ) {
      const unit = signature.canonicalSalesUnitId
        ? salesUnitsById.get(signature.canonicalSalesUnitId)
        : null;
      if (unit?.isActive) target = unit.id;
    }
    setItem(item, target);
  }

  // Apply a consistently inferred leaf target back to unresolved touched rows in the same commit.
  const inferenceSignatureIds =
    targetSignatureIds ?? new Set(signaturesById.keys());
  const signatureItemMappings = new Map<string, Set<string>>();
  for (const item of database.orderItems) {
    const signatureId = item.orderSourceSignatureId;
    if (
      item.storeId !== storeId ||
      !signatureId ||
      !inferenceSignatureIds.has(signatureId) ||
      !item.canonicalSalesUnitId ||
      !assignable(item.canonicalSalesUnitId, item)
    )
      continue;
    const ids = signatureItemMappings.get(signatureId) ?? new Set<string>();
    ids.add(item.canonicalSalesUnitId);
    signatureItemMappings.set(signatureId, ids);
  }
  for (const [signatureId, unitIds] of signatureItemMappings) {
    const signature = signaturesById.get(signatureId);
    if (
      !signature ||
      signature.confirmedAt ||
      blockedSignatures.has(signatureId)
    )
      continue;
    if (unitIds.size > 1) setSignature(signature, null, "CONFLICT");
    else {
      const inferredId = [...unitIds][0];
      const group = groupsBySignature.get(signatureId);
      const explicitId = idResolvedSignatures.has(signatureId);
      if (
        (!ambiguousSignatures.has(signatureId) || explicitId) &&
        (!group || group.candidateIds.has(inferredId) || explicitId)
      ) {
        setSignature(signature, inferredId, "MAPPED");
      }
    }
  }
  for (const signatureId of blockedSignatures) {
    const signature = signaturesById.get(signatureId);
    if (signature && !signature.confirmedAt)
      setSignature(signature, null, "CONFLICT");
  }
  for (const item of touchedItems) {
    if (
      item.canonicalSalesUnitId ||
      blockedItems.has(item.id) ||
      !item.orderSourceSignatureId
    )
      continue;
    const signature = signaturesById.get(item.orderSourceSignatureId);
    if (
      !signature ||
      signature.confirmedAt ||
      signature.mappingStatus !== "MAPPED" ||
      !signature.canonicalSalesUnitId
    )
      continue;
    setItem(item, signature.canonicalSalesUnitId);
  }
};

export const recalculateOrderMappingsForStore = (
  database: DatabaseShape,
  storeId: string,
): void => {
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

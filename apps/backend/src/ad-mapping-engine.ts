import {
  AdCampaignSignature,
  AdCampaignDailyCost,
  AdUploadPreviewRow,
  CampaignMappingReason,
  CampaignSalesUnitMapping,
  CanonicalSalesUnit,
  DatabaseShape,
  normalizeText,
} from "@patima/shared";
import { hashJson, createId, nowIso } from "./helpers";
import { getActiveSalesUnitsForCampaignMapping, resolveCampaignAutoMapping } from "./sales-unit-auto-mapper";

export type AdMappingOverride =
  | { type: "MANUAL_MAPPED"; canonicalSalesUnitId: string }
  | { type: "INTENTIONALLY_UNMAPPED"; reasonNote: string | null };

export interface AdMappingEvaluation {
  canonicalSalesUnitId: string | null;
  matchedRuleCount: number;
  mappingReason: CampaignMappingReason;
  reasonNote: string | null;
  reasonNoteInherited: boolean;
}

const indexSalesUnits = (database: DatabaseShape) => {
  const index = new Map<string, CanonicalSalesUnit>();
  for (const unit of database.canonicalSalesUnits) {
    if (!index.has(unit.id)) index.set(unit.id, unit);
  }
  return index;
};

export const getActiveCampaignMappings = (database: DatabaseShape, storeId: string): CampaignSalesUnitMapping[] => {
  const unitsById = indexSalesUnits(database);
  return database.campaignMappings.filter((item) =>
    item.storeId === storeId && item.isActive && unitsById.get(item.canonicalSalesUnitId)?.isActive,
  );
};

export const getAutoMatchSalesUnitsSnapshot = (database: DatabaseShape, storeId: string) =>
  getActiveSalesUnitsForCampaignMapping(database, storeId).map((item) => ({
    id: item.id,
    normalizedMatchAliases: item.normalizedMatchAliases,
  }));

interface AdMappingContext {
  unitsById: Map<string, CanonicalSalesUnit>;
  explicitRules: CampaignSalesUnitMapping[];
  autoMatchSalesUnits: CanonicalSalesUnit[];
}

const createAdMappingContext = (database: DatabaseShape, storeId: string): AdMappingContext => {
  const unitsById = indexSalesUnits(database);
  return {
    unitsById,
    explicitRules: database.campaignMappings.filter((item) =>
      item.storeId === storeId && item.isActive && unitsById.get(item.canonicalSalesUnitId)?.isActive,
    ),
    autoMatchSalesUnits: getActiveSalesUnitsForCampaignMapping(database, storeId),
  };
};

const hashMappingContext = (context: AdMappingContext): string =>
  hashJson({
    explicitRules: context.explicitRules.map((item) => ({
      id: item.id,
      normalizedCampaignPattern: item.normalizedCampaignPattern,
      canonicalSalesUnitId: item.canonicalSalesUnitId,
    })),
    autoMatchSalesUnits: context.autoMatchSalesUnits.map((item) => ({
      id: item.id,
      normalizedMatchAliases: item.normalizedMatchAliases,
    })),
  });

export const getRuleSnapshotHash = (database: DatabaseShape, storeId: string): string =>
  hashMappingContext(createAdMappingContext(database, storeId));

export const getOverrideSnapshotHash = (database: DatabaseShape, storeId: string): string =>
  hashJson([
    ...database.adCampaignSignatures
      .filter((item) => item.storeId === storeId && item.confirmedAt)
      .map((signature) => ({
        signatureId: signature.id,
        campaignId: signature.campaignId,
        normalizedCampaignName: signature.normalizedCampaignName,
        mappingReason: signature.mappingReason,
        canonicalSalesUnitId: signature.canonicalSalesUnitId,
        reasonNote: signature.reasonNote,
        confirmedAt: signature.confirmedAt,
      })),
    ...database.adCampaignDailyCosts
      .filter((item) => item.storeId === storeId)
      .map((item) => ({
        row: item,
        override: getAdMappingOverride(item),
      }))
      .filter((item): item is { row: AdCampaignDailyCost; override: AdMappingOverride } => item.override !== null)
      .map(({ row, override }) => ({
        campaignId: row.campaignId,
        normalizedCampaignName: row.normalizedCampaignName,
        reportDate: row.reportDate,
        mappingReason: override.type,
        canonicalSalesUnitId:
          override.type === "MANUAL_MAPPED" ? override.canonicalSalesUnitId : null,
        reasonNote:
          override.type === "INTENTIONALLY_UNMAPPED" ? override.reasonNote : null,
      })),
  ]);

export const getAdMappingOverride = (
  item: Pick<AdCampaignDailyCost | AdUploadPreviewRow | AdCampaignSignature, "canonicalSalesUnitId" | "mappingReason" | "reasonNote">,
): AdMappingOverride | null => {
  if (item.mappingReason === "MANUAL_MAPPED" && item.canonicalSalesUnitId) {
    return {
      type: "MANUAL_MAPPED",
      canonicalSalesUnitId: item.canonicalSalesUnitId,
    };
  }

  if (item.mappingReason === "INTENTIONALLY_UNMAPPED") {
    return {
      type: "INTENTIONALLY_UNMAPPED",
      reasonNote: item.reasonNote,
    };
  }

  return null;
};

/**
 * 자식 판매단위를 부모 판매단위로 승격시키는 헬퍼 함수.
 * 자식이면 부모로 승격, 아니면 그대로 반환.
 */
function resolveTargetSalesUnitId(context: AdMappingContext, candidateId: string | null): string | null {
  if (!candidateId) {
    return null;
  }
  const candidate = context.unitsById.get(candidateId);
  if (!candidate) {
    return candidateId;
  }
  // 자식이면 부모로 승격, 아니면 그대로
  return candidate.parentSalesUnitId ?? candidate.id;
}

const evaluateAdMappingWithContext = (
  context: AdMappingContext,
  normalizedCampaignName: string,
  override?: AdMappingOverride | null,
): AdMappingEvaluation => {
  if (override?.type === "MANUAL_MAPPED") {
    const resolvedId = resolveTargetSalesUnitId(context, override.canonicalSalesUnitId);
    return {
      canonicalSalesUnitId: resolvedId,
      matchedRuleCount: 0,
      mappingReason: "MANUAL_MAPPED",
      reasonNote: null,
      reasonNoteInherited: true,
    };
  }

  if (override?.type === "INTENTIONALLY_UNMAPPED") {
    return {
      canonicalSalesUnitId: null,
      matchedRuleCount: 0,
      mappingReason: "INTENTIONALLY_UNMAPPED",
      reasonNote: override.reasonNote,
      reasonNoteInherited: true,
    };
  }

  // 1단계: 명시적 캠페인 매핑 규칙 검사
  const matches = context.explicitRules.filter((rule) =>
    normalizedCampaignName.includes(rule.normalizedCampaignPattern),
  );
  if (matches.length === 1) {
    const resolvedId = resolveTargetSalesUnitId(context, matches[0].canonicalSalesUnitId);
    return {
      canonicalSalesUnitId: resolvedId,
      matchedRuleCount: 1,
      mappingReason: "RULE_MATCHED",
      reasonNote: null,
      reasonNoteInherited: false,
    };
  }
  if (matches.length > 1) {
    return {
      canonicalSalesUnitId: null,
      matchedRuleCount: matches.length,
      mappingReason: "MULTIPLE_RULES",
      reasonNote: "여러 규칙이 동시에 일치했습니다.",
      reasonNoteInherited: false,
    };
  }

  // 2단계: 사용자가 설정한 판매단위/그룹 키워드로 매핑
  const fallback = resolveCampaignAutoMapping(
    context.autoMatchSalesUnits,
    normalizedCampaignName,
  );
  if (fallback.canonicalSalesUnitId) {
    const resolvedId = resolveTargetSalesUnitId(context, fallback.canonicalSalesUnitId);
    return {
      canonicalSalesUnitId: resolvedId,
      matchedRuleCount: fallback.candidateCount,
      mappingReason: "RULE_MATCHED",
      reasonNote: null,
      reasonNoteInherited: false,
    };
  }
  if (fallback.ambiguous) {
    return {
      canonicalSalesUnitId: null,
      matchedRuleCount: fallback.candidateCount,
      mappingReason: "MULTIPLE_RULES",
      reasonNote: "여러 규칙이 동시에 일치했습니다.",
      reasonNoteInherited: false,
    };
  }

  return {
    canonicalSalesUnitId: null,
    matchedRuleCount: 0,
    mappingReason: "NO_RULE",
    reasonNote: "일치하는 규칙이 없습니다.",
    reasonNoteInherited: false,
  };
};

export const evaluateAdMapping = (
  database: DatabaseShape,
  storeId: string,
  normalizedCampaignName: string,
  override?: AdMappingOverride | null,
): AdMappingEvaluation =>
  evaluateAdMappingWithContext(createAdMappingContext(database, storeId), normalizedCampaignName, override);

export const normalizeCampaignPattern = (pattern: string): string => normalizeText(pattern);

const getSignatureCampaignId = (campaignId: string | null | undefined): string | null => {
  const trimmed = campaignId?.trim();
  return trimmed ? trimmed : null;
};

export const getAdCampaignSignatureKey = (
  value: Pick<AdCampaignSignature, "storeId" | "channel" | "campaignId" | "normalizedCampaignName">,
): string =>
  [
    value.storeId,
    value.channel,
    value.campaignId?.trim() ? `id:${value.campaignId.trim()}` : `name:${value.normalizedCampaignName}`,
  ].join("|");

/** Build once inside a write and pass to upserts made against that same draft. */
export const createAdCampaignSignatureIndex = (database: DatabaseShape): Map<string, AdCampaignSignature> => {
  const index = new Map<string, AdCampaignSignature>();
  for (const signature of database.adCampaignSignatures) {
    const key = getAdCampaignSignatureKey(signature);
    if (!index.has(key)) index.set(key, signature);
  }
  return index;
};

export const findAdCampaignSignature = (
  database: DatabaseShape,
  params: {
    storeId: string;
    channel?: "NAVER_DA";
    campaignId?: string | null;
    normalizedCampaignName: string;
  },
): AdCampaignSignature | null => {
  const key = [
    params.storeId,
    params.channel ?? "NAVER_DA",
    getSignatureCampaignId(params.campaignId)
      ? `id:${getSignatureCampaignId(params.campaignId)}`
      : `name:${params.normalizedCampaignName}`,
  ].join("|");
  return database.adCampaignSignatures.find((signature) => getAdCampaignSignatureKey(signature) === key) ?? null;
};

export const upsertAdCampaignSignature = (
  database: DatabaseShape,
  params: {
    storeId: string;
    channel?: "NAVER_DA";
    campaignId?: string | null;
    campaignName: string;
    normalizedCampaignName?: string;
    reportDate?: string | null;
    countUsage?: boolean;
  },
  signatureIndex?: Map<string, AdCampaignSignature>,
): AdCampaignSignature => {
  const timestamp = nowIso();
  const channel = params.channel ?? "NAVER_DA";
  const normalizedCampaignName = params.normalizedCampaignName ?? normalizeText(params.campaignName);
  const campaignId = getSignatureCampaignId(params.campaignId);
  const lookup = {
    storeId: params.storeId,
    channel,
    campaignId,
    normalizedCampaignName,
  };
  const key = getAdCampaignSignatureKey(lookup);
  const existing = signatureIndex
    ? signatureIndex.get(key)
    : findAdCampaignSignature(database, lookup);

  if (existing) {
    existing.campaignNameSnapshot = params.campaignName;
    existing.normalizedCampaignName = normalizedCampaignName;
    existing.campaignId = existing.campaignId ?? campaignId;
    if (params.countUsage !== false) {
      existing.usageCount = (existing.usageCount ?? 0) + 1;
    }
    if (params.reportDate) {
      if (!existing.firstSeenDate || params.reportDate < existing.firstSeenDate) {
        existing.firstSeenDate = params.reportDate;
      }
      if (!existing.lastSeenDate || params.reportDate > existing.lastSeenDate) {
        existing.lastSeenDate = params.reportDate;
      }
    }
    existing.updatedAt = timestamp;
    return existing;
  }

  const created: AdCampaignSignature = {
    id: createId(),
    storeId: params.storeId,
    channel,
    campaignId,
    campaignNameSnapshot: params.campaignName,
    normalizedCampaignName,
    canonicalSalesUnitId: null,
    mappingReason: "NO_RULE",
    matchedRuleCount: 0,
    reasonNote: "일치하는 규칙이 없습니다.",
    reasonNoteInherited: false,
    confirmedAt: null,
    usageCount: params.countUsage === false ? 0 : 1,
    firstSeenDate: params.reportDate ?? null,
    lastSeenDate: params.reportDate ?? null,
    lastAutoMappedAt: null,
    mappingRuleHash: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  database.adCampaignSignatures.push(created);
  signatureIndex?.set(key, created);
  return created;
};

export const ensureAdCampaignSignaturesForStore = (
  database: DatabaseShape,
  storeId: string,
  rowIds?: Set<string> | string[] | null,
  rows: readonly AdCampaignDailyCost[] = database.adCampaignDailyCosts,
): Set<string> => {
  const targetRowIds = rowIds ? new Set(Array.from(rowIds).filter(Boolean)) : null;
  const touchedSignatureIds = new Set<string>();
  let signatureIndex: Map<string, AdCampaignSignature> | undefined;

  rows
    .filter((row) => row.storeId === storeId && (!targetRowIds || targetRowIds.has(row.id)))
    .forEach((row) => {
      if (row.adCampaignSignatureId) {
        touchedSignatureIds.add(row.adCampaignSignatureId);
        return;
      }

      signatureIndex ??= createAdCampaignSignatureIndex(database);
      const signature = upsertAdCampaignSignature(database, {
        storeId,
        campaignId: row.campaignId,
        campaignName: row.campaignName,
        normalizedCampaignName: row.normalizedCampaignName,
        reportDate: row.reportDate,
      }, signatureIndex);
      row.adCampaignSignatureId = signature.id;
      touchedSignatureIds.add(signature.id);
    });

  return touchedSignatureIds;
};

export const applyAdCampaignSignatureToRows = (
  database: DatabaseShape,
  params: {
    storeId: string;
    signatureIds?: Set<string> | string[] | null;
    dateFrom?: string | null;
    dateTo?: string | null;
    rows?: readonly AdCampaignDailyCost[];
  },
): void => {
  const timestamp = nowIso();
  const signatureIds = params.signatureIds ? new Set(Array.from(params.signatureIds).filter(Boolean)) : null;
  const signaturesById = new Map(database.adCampaignSignatures.map((signature) => [signature.id, signature]));

  (params.rows ?? database.adCampaignDailyCosts)
    .filter(
      (row) =>
        row.storeId === params.storeId &&
        row.adCampaignSignatureId &&
        (!signatureIds || signatureIds.has(row.adCampaignSignatureId)) &&
        (!params.dateFrom || row.reportDate >= params.dateFrom) &&
        (!params.dateTo || row.reportDate <= params.dateTo),
    )
    .forEach((row) => {
      const signature = signaturesById.get(row.adCampaignSignatureId!);
      if (!signature) {
        return;
      }
      const nextCanonicalSalesUnitId = signature.canonicalSalesUnitId;
      const nextMatchedRuleCount = signature.matchedRuleCount;
      const nextMappingReason = signature.mappingReason;
      const nextReasonNote = signature.reasonNote;
      const nextReasonNoteInherited = signature.reasonNoteInherited;

      if (
        row.canonicalSalesUnitId === nextCanonicalSalesUnitId &&
        row.matchedRuleCount === nextMatchedRuleCount &&
        row.mappingReason === nextMappingReason &&
        row.reasonNote === nextReasonNote &&
        row.reasonNoteInherited === nextReasonNoteInherited
      ) {
        return;
      }

      row.canonicalSalesUnitId = signature.canonicalSalesUnitId;
      row.matchedRuleCount = signature.matchedRuleCount;
      row.mappingReason = signature.mappingReason;
      row.reasonNote = signature.reasonNote;
      row.reasonNoteInherited = signature.reasonNoteInherited;
      row.updatedAt = timestamp;
    });
};

export const refreshAdCampaignSignatureSummaries = (
  database: DatabaseShape,
  params: {
    storeId: string;
    signatureIds?: Set<string> | string[] | null;
  },
): void => {
  const signatureIds = params.signatureIds ? new Set(Array.from(params.signatureIds).filter(Boolean)) : null;
  const summaries = new Map<
    string,
    {
      usageCount: number;
      firstSeenDate: string | null;
      lastSeenDate: string | null;
      latestRow: AdCampaignDailyCost | null;
    }
  >();

  database.adCampaignDailyCosts
    .filter(
      (row) =>
        row.storeId === params.storeId &&
        row.adCampaignSignatureId &&
        (!signatureIds || signatureIds.has(row.adCampaignSignatureId)),
    )
    .forEach((row) => {
      const current = summaries.get(row.adCampaignSignatureId!) ?? {
        usageCount: 0,
        firstSeenDate: null,
        lastSeenDate: null,
        latestRow: null,
      };
      current.usageCount += 1;
      if (!current.firstSeenDate || row.reportDate < current.firstSeenDate) {
        current.firstSeenDate = row.reportDate;
      }
      if (!current.lastSeenDate || row.reportDate > current.lastSeenDate) {
        current.lastSeenDate = row.reportDate;
      }
      if (
        !current.latestRow ||
        `${row.reportDate}:${row.updatedAt}`.localeCompare(`${current.latestRow.reportDate}:${current.latestRow.updatedAt}`) > 0
      ) {
        current.latestRow = row;
      }
      summaries.set(row.adCampaignSignatureId!, current);
    });

  const timestamp = nowIso();
  database.adCampaignSignatures
    .filter((signature) => signature.storeId === params.storeId && (!signatureIds || signatureIds.has(signature.id)))
    .forEach((signature) => {
      const summary = summaries.get(signature.id);
      signature.usageCount = summary?.usageCount ?? 0;
      signature.firstSeenDate = summary?.firstSeenDate ?? null;
      signature.lastSeenDate = summary?.lastSeenDate ?? null;
      if (summary?.latestRow) {
        signature.campaignNameSnapshot = summary.latestRow.campaignName;
        signature.normalizedCampaignName = summary.latestRow.normalizedCampaignName;
        signature.campaignId = summary.latestRow.campaignId || signature.campaignId;
      }
      signature.updatedAt = timestamp;
    });
};

export const recalculateAdCampaignSignaturesForStore = (
  database: DatabaseShape,
  storeId: string,
  options?: {
    signatureIds?: Set<string> | string[] | null;
    onlyUnconfirmed?: boolean;
    applyToRows?: boolean;
    applyToRowsFrom?: string | null;
    applyToRowsTo?: string | null;
    /** Rows belonging to this draft; limits both signature repair and mapping writes. */
    rows?: readonly AdCampaignDailyCost[];
  },
): void => {
  const shouldApplyToRows =
    options?.applyToRows === true ||
    options?.applyToRowsFrom != null ||
    options?.applyToRowsTo != null;
  if (shouldApplyToRows) {
    ensureAdCampaignSignaturesForStore(database, storeId, null, options?.rows);
  }
  const targetSignatureIds = options?.signatureIds
    ? new Set(Array.from(options.signatureIds).filter(Boolean))
    : null;
  const candidates = database.adCampaignSignatures.filter(
    (signature) => signature.storeId === storeId && (!targetSignatureIds || targetSignatureIds.has(signature.id)),
  );
  const autoCandidates = candidates.filter((signature) => !signature.confirmedAt);
  const timestamp = nowIso();
  const context = createAdMappingContext(database, storeId);
  const ruleHash = hashMappingContext(context);
  autoCandidates.forEach((signature) => {
    const mapping = evaluateAdMappingWithContext(context, signature.normalizedCampaignName);
    const nextCanonicalSalesUnitId = mapping.canonicalSalesUnitId;

    if (
      signature.canonicalSalesUnitId === nextCanonicalSalesUnitId &&
      signature.matchedRuleCount === mapping.matchedRuleCount &&
      signature.mappingReason === mapping.mappingReason &&
      signature.reasonNote === mapping.reasonNote &&
      signature.reasonNoteInherited === mapping.reasonNoteInherited &&
      signature.mappingRuleHash === ruleHash
    ) {
      return;
    }

    signature.canonicalSalesUnitId = nextCanonicalSalesUnitId;
    signature.matchedRuleCount = mapping.matchedRuleCount;
    signature.mappingReason = mapping.mappingReason;
    signature.reasonNote = mapping.reasonNote;
    signature.reasonNoteInherited = mapping.reasonNoteInherited;
    signature.lastAutoMappedAt = timestamp;
    signature.mappingRuleHash = ruleHash;
    signature.updatedAt = timestamp;
  });

  if (shouldApplyToRows) {
    applyAdCampaignSignatureToRows(database, {
      storeId,
      signatureIds: targetSignatureIds ?? new Set(candidates.map((signature) => signature.id)),
      dateFrom: options?.applyToRowsFrom,
      dateTo: options?.applyToRowsTo,
      rows: options?.rows,
    });
  }
};

export const recalculateAdMappingsForStore = (database: DatabaseShape, storeId: string): void => {
  recalculateAdCampaignSignaturesForStore(database, storeId, { applyToRows: true });
};

export const recalculateAdMappingsForStoreLegacyRows = (database: DatabaseShape, storeId: string): void => {
  const context = createAdMappingContext(database, storeId);
  database.adCampaignDailyCosts
    .filter((item) => item.storeId === storeId)
    .forEach((item) => {
      const mapping = evaluateAdMappingWithContext(context, item.normalizedCampaignName, getAdMappingOverride(item));

      item.canonicalSalesUnitId = mapping.canonicalSalesUnitId;

      item.matchedRuleCount = mapping.matchedRuleCount;
      item.mappingReason = mapping.mappingReason;
      item.reasonNote = mapping.reasonNote;
      item.reasonNoteInherited = mapping.reasonNoteInherited;
      item.updatedAt = new Date().toISOString();
    });
};

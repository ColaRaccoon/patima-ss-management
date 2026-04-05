import {
  AdCampaignDailyCost,
  AdUploadPreviewRow,
  CampaignMappingReason,
  CampaignSalesUnitMapping,
  DatabaseShape,
  normalizeText,
} from "@patima/shared";
import { hashJson } from "./helpers";
import { getActiveSalesUnitsForAutoMapping, resolveCampaignAutoMapping } from "./sales-unit-auto-mapper";

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

export const getActiveCampaignMappings = (database: DatabaseShape, storeId: string): CampaignSalesUnitMapping[] =>
  database.campaignMappings.filter((item) => {
    const salesUnit = database.canonicalSalesUnits.find((entry) => entry.id === item.canonicalSalesUnitId);
    return item.storeId === storeId && item.isActive && salesUnit?.isActive;
  });

export const getAutoMatchSalesUnitsSnapshot = (database: DatabaseShape, storeId: string) =>
  getActiveSalesUnitsForAutoMapping(database, storeId).map((item) => ({
    id: item.id,
    normalizedDisplayName: item.normalizedDisplayName,
    normalizedStandardProductName: item.normalizedStandardProductName,
    normalizedStandardOptionName: item.normalizedStandardOptionName,
  }));

export const getRuleSnapshotHash = (database: DatabaseShape, storeId: string): string =>
  hashJson({
    explicitRules: getActiveCampaignMappings(database, storeId).map((item) => ({
      id: item.id,
      normalizedCampaignPattern: item.normalizedCampaignPattern,
      canonicalSalesUnitId: item.canonicalSalesUnitId,
    })),
    autoMatchSalesUnits: getAutoMatchSalesUnitsSnapshot(database, storeId),
  });

export const getOverrideSnapshotHash = (database: DatabaseShape, storeId: string): string =>
  hashJson(
    database.adCampaignDailyCosts
      .filter((item) => item.storeId === storeId)
      .map((item) => ({
        row: item,
        override: getAdMappingOverride(item),
      }))
      .filter((item): item is { row: AdCampaignDailyCost; override: AdMappingOverride } => item.override !== null)
      .map(({ row, override }) => ({
        normalizedCampaignName: row.normalizedCampaignName,
        reportDate: row.reportDate,
        mappingReason: override.type,
        canonicalSalesUnitId:
          override.type === "MANUAL_MAPPED" ? override.canonicalSalesUnitId : null,
        reasonNote:
          override.type === "INTENTIONALLY_UNMAPPED" ? override.reasonNote : null,
      })),
  );

export const getAdMappingOverride = (
  item: Pick<AdCampaignDailyCost | AdUploadPreviewRow, "canonicalSalesUnitId" | "mappingReason" | "reasonNote">,
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

export const evaluateAdMapping = (
  database: DatabaseShape,
  storeId: string,
  normalizedCampaignName: string,
  override?: AdMappingOverride | null,
): AdMappingEvaluation => {
  if (override?.type === "MANUAL_MAPPED") {
    return {
      canonicalSalesUnitId: override.canonicalSalesUnitId,
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

  const matches = getActiveCampaignMappings(database, storeId).filter((rule) =>
    normalizedCampaignName.includes(rule.normalizedCampaignPattern),
  );
  if (matches.length === 1) {
    return {
      canonicalSalesUnitId: matches[0].canonicalSalesUnitId,
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

  const fallback = resolveCampaignAutoMapping(
    getActiveSalesUnitsForAutoMapping(database, storeId),
    normalizedCampaignName,
  );
  if (fallback.canonicalSalesUnitId) {
    return {
      canonicalSalesUnitId: fallback.canonicalSalesUnitId,
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

export const normalizeCampaignPattern = (pattern: string): string => normalizeText(pattern);

export const recalculateAdMappingsForStore = (database: DatabaseShape, storeId: string): void => {
  database.adCampaignDailyCosts
    .filter((item) => item.storeId === storeId)
    .forEach((item) => {
      const mapping = evaluateAdMapping(database, storeId, item.normalizedCampaignName, getAdMappingOverride(item));
      item.canonicalSalesUnitId = mapping.canonicalSalesUnitId;
      item.matchedRuleCount = mapping.matchedRuleCount;
      item.mappingReason = mapping.mappingReason;
      item.reasonNote = mapping.reasonNote;
      item.reasonNoteInherited = mapping.reasonNoteInherited;
      item.updatedAt = new Date().toISOString();
    });
};

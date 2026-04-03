import { AdCampaignDailyCost, AdUploadPreviewRow, CampaignSalesUnitMapping, DatabaseShape, normalizeText } from "@patima/shared";
import { hashJson } from "./helpers";

export interface AdMappingEvaluation {
  canonicalSalesUnitId: string | null;
  matchedRuleCount: number;
  mappingReason: "RULE_MATCHED" | "NO_RULE" | "MULTIPLE_RULES" | "INTENTIONALLY_UNMAPPED";
  reasonNote: string | null;
  reasonNoteInherited: boolean;
}

export const getActiveCampaignMappings = (database: DatabaseShape, storeId: string): CampaignSalesUnitMapping[] =>
  database.campaignMappings.filter((item) => {
    const salesUnit = database.canonicalSalesUnits.find((entry) => entry.id === item.canonicalSalesUnitId);
    return item.storeId === storeId && item.isActive && salesUnit?.isActive;
  });

export const getRuleSnapshotHash = (database: DatabaseShape, storeId: string): string =>
  hashJson(
    getActiveCampaignMappings(database, storeId).map((item) => ({
      id: item.id,
      normalizedCampaignPattern: item.normalizedCampaignPattern,
      canonicalSalesUnitId: item.canonicalSalesUnitId,
    })),
  );

export const getOverrideSnapshotHash = (database: DatabaseShape, storeId: string): string =>
  hashJson(
    database.adCampaignDailyCosts
      .filter((item) => item.storeId === storeId && item.mappingReason === "INTENTIONALLY_UNMAPPED")
      .map((item) => ({
        normalizedCampaignName: item.normalizedCampaignName,
        reportDate: item.reportDate,
        reasonNote: item.reasonNote,
      })),
  );

export const evaluateAdMapping = (
  database: DatabaseShape,
  storeId: string,
  normalizedCampaignName: string,
  inheritedReasonNote?: string | null,
): AdMappingEvaluation => {
  if (inheritedReasonNote) {
    return {
      canonicalSalesUnitId: null,
      matchedRuleCount: 0,
      mappingReason: "INTENTIONALLY_UNMAPPED",
      reasonNote: inheritedReasonNote,
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
  return {
    canonicalSalesUnitId: null,
    matchedRuleCount: 0,
    mappingReason: "NO_RULE",
    reasonNote: "일치하는 규칙이 없습니다.",
    reasonNoteInherited: false,
  };
};

export const normalizeCampaignPattern = (pattern: string): string => normalizeText(pattern);

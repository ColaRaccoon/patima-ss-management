import {
  AdCampaignDailyCost,
  AdUploadPreviewRow,
  CampaignMappingReason,
  CampaignSalesUnitMapping,
  DatabaseShape,
  normalizeText,
} from "@patima/shared";
import { hashJson, createId, nowIso } from "./helpers";
import { getActiveSalesUnitsForAutoMapping, resolveCampaignAutoMapping } from "./sales-unit-auto-mapper";

export type AdMappingOverride =
  | { type: "MANUAL_MAPPED"; canonicalSalesUnitId: string }
  | { type: "INTENTIONALLY_UNMAPPED"; reasonNote: string | null };

/**
 * 캠페인명 기반 자동매핑 규칙
 * 세부 키워드를 먼저 검사한 후 포괄 키워드를 검사하여 우선순위 적용
 */
interface KeywordMappingRule {
  keywords: string[];
  displayNamePattern: string;
  isStoreLevel?: boolean;
}

const KEYWORD_MAPPING_RULES: KeywordMappingRule[] = [
  // 세부 키워드 (specifics)
  { keywords: ["한줄무릎보호대"], displayNamePattern: "한줄 무릎보호대" },
  { keywords: ["두줄무릎보호대", "인피니티가드_두줄"], displayNamePattern: "두줄 무릎보호대" },
  { keywords: ["런닝양말"], displayNamePattern: "러닝양말" },
  { keywords: ["다이어트양말", "인피니티가드_다이어트양말"], displayNamePattern: "다이어트양말" },
  { keywords: ["유쉴드", "유쉴드마스크"], displayNamePattern: "자외선차단 마스크" },
  { keywords: ["카프슬리브"], displayNamePattern: "쿨토시" },
  // 포괄 키워드 (broad - 세부 키워드 미포함 시에만 매핑)
  { keywords: ["카탈로그", "키워드타겟"], displayNamePattern: "STORE_LEVEL", isStoreLevel: true },
];

/**
 * 캠페인명에서 키워드 기반 매핑 대상을 찾음
 * 세부 키워드를 먼저 검사한 후 포괄 키워드를 검사
 */
function findKeywordMappingRule(campaignName: string): KeywordMappingRule | null {
  // 1단계: 세부 키워드 검사
  for (const rule of KEYWORD_MAPPING_RULES) {
    if (rule.isStoreLevel) continue; // 포괄 키워드는 후반부에서만 검사
    for (const keyword of rule.keywords) {
      if (campaignName.includes(keyword)) {
        return rule;
      }
    }
  }

  // 2단계: 포괄 키워드 검사
  // "무릎보호대" 또는 "인피니티가드"가 포함되었을 때만 검사 (세부 키워드 미포함)
  const hasBroadKeywordNeedsCheck = campaignName.includes("무릎보호대") || campaignName.includes("인피니티가드");
  if (hasBroadKeywordNeedsCheck) {
    // "무릎보호대" 단독 (한줄/두줄 미포함) → 스토어 전체
    if (
      campaignName.includes("무릎보호대") &&
      !campaignName.includes("한줄") &&
      !campaignName.includes("두줄")
    ) {
      return { keywords: ["무릎보호대"], displayNamePattern: "STORE_LEVEL", isStoreLevel: true };
    }
    // "인피니티가드" 단독 (두줄/다이어트양말 등 미포함) → 스토어 전체
    if (
      campaignName.includes("인피니티가드") &&
      !campaignName.includes("두줄") &&
      !campaignName.includes("다이어트양말")
    ) {
      return { keywords: ["인피니티가드"], displayNamePattern: "STORE_LEVEL", isStoreLevel: true };
    }
  }

  // 3단계: 카탈로그, 키워드타겟 포괄 키워드
  for (const rule of KEYWORD_MAPPING_RULES) {
    if (!rule.isStoreLevel) continue;
    if (rule.isStoreLevel !== true) continue;
    for (const keyword of rule.keywords) {
      if (campaignName.includes(keyword)) {
        return rule;
      }
    }
  }

  return null;
}

export interface AdMappingEvaluation {
  canonicalSalesUnitId: string | null;
  matchedRuleCount: number;
  mappingReason: CampaignMappingReason;
  reasonNote: string | null;
  reasonNoteInherited: boolean;
  needsStoreLevelUnit?: boolean;
}

export const getActiveCampaignMappings = (database: DatabaseShape, storeId: string): CampaignSalesUnitMapping[] =>
  database.campaignMappings.filter((item) => {
    const salesUnit = database.canonicalSalesUnits.find((entry) => entry.id === item.canonicalSalesUnitId);
    return item.storeId === storeId && item.isActive && salesUnit?.isActive;
  });

export const getAutoMatchSalesUnitsSnapshot = (database: DatabaseShape, storeId: string) =>
  getActiveSalesUnitsForAutoMapping(database, storeId).map((item) => ({
    id: item.id,
    normalizedMatchAliases: item.normalizedMatchAliases,
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
        campaignId: row.campaignId,
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

/**
 * 자식 판매단위를 부모 판매단위로 승격시키는 헬퍼 함수.
 * 자식이면 부모로 승격, 아니면 그대로 반환.
 */
function resolveTargetSalesUnitId(database: DatabaseShape, candidateId: string | null): string | null {
  if (!candidateId) {
    return null;
  }
  const candidate = database.canonicalSalesUnits.find((u) => u.id === candidateId);
  if (!candidate) {
    return candidateId;
  }
  // 자식이면 부모로 승격, 아니면 그대로
  return candidate.parentSalesUnitId ?? candidate.id;
}

export const evaluateAdMapping = (
  database: DatabaseShape,
  storeId: string,
  normalizedCampaignName: string,
  override?: AdMappingOverride | null,
): AdMappingEvaluation => {
  if (override?.type === "MANUAL_MAPPED") {
    const resolvedId = resolveTargetSalesUnitId(database, override.canonicalSalesUnitId);
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
  const matches = getActiveCampaignMappings(database, storeId).filter((rule) =>
    normalizedCampaignName.includes(rule.normalizedCampaignPattern),
  );
  if (matches.length === 1) {
    const resolvedId = resolveTargetSalesUnitId(database, matches[0].canonicalSalesUnitId);
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

  // 2단계: 키워드 기반 자동매핑 규칙 검사
  const keywordRule = findKeywordMappingRule(normalizedCampaignName);
  if (keywordRule) {
    if (keywordRule.isStoreLevel) {
      // 스토어 전체 광고비로 매핑
      const storeLevelUnit = database.canonicalSalesUnits.find(
        (u) => u.storeId === storeId && u.isStoreLevel === true,
      );
      if (storeLevelUnit) {
        return {
          canonicalSalesUnitId: storeLevelUnit.id,
          matchedRuleCount: 1,
          mappingReason: "RULE_MATCHED",
          reasonNote: `키워드 규칙: ${keywordRule.keywords.join(", ")} → 스토어 전체`,
          reasonNoteInherited: false,
        };
      }
      // 스토어 레벨 판매단위가 없으면 생성 필요 표시
      return {
        canonicalSalesUnitId: null,
        matchedRuleCount: 1,
        mappingReason: "NO_RULE",
        reasonNote: `키워드 규칙: ${keywordRule.keywords.join(", ")} → 스토어 전체 (판매단위 생성 필요)`,
        reasonNoteInherited: false,
        needsStoreLevelUnit: true,
      };
    } else {
      // 특정 판매단위로 매핑
      const targetUnit = database.canonicalSalesUnits.find(
        (u) =>
          u.storeId === storeId &&
          u.isActive &&
          normalizeText(u.displayName) === normalizeText(keywordRule.displayNamePattern),
      );
      if (targetUnit) {
        const resolvedId = resolveTargetSalesUnitId(database, targetUnit.id);
        return {
          canonicalSalesUnitId: resolvedId,
          matchedRuleCount: 1,
          mappingReason: "RULE_MATCHED",
          reasonNote: `키워드 규칙: ${keywordRule.keywords.join(", ")} → ${keywordRule.displayNamePattern}`,
          reasonNoteInherited: false,
        };
      }
    }
  }

  // 3단계: 텍스트 기반 자동매핑 폴백
  const fallback = resolveCampaignAutoMapping(
    getActiveSalesUnitsForAutoMapping(database, storeId),
    normalizedCampaignName,
  );
  if (fallback.canonicalSalesUnitId) {
    const resolvedId = resolveTargetSalesUnitId(database, fallback.canonicalSalesUnitId);
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

export const normalizeCampaignPattern = (pattern: string): string => normalizeText(pattern);

export const recalculateAdMappingsForStore = (database: DatabaseShape, storeId: string): void => {
  // 먼저 필요한 스토어 레벨 판매단위가 있는지 확인
  const needsStoreLevelUnit = database.adCampaignDailyCosts
    .filter((item) => item.storeId === storeId)
    .some((item) => {
      const mapping = evaluateAdMapping(database, storeId, item.normalizedCampaignName, getAdMappingOverride(item));
      return mapping.needsStoreLevelUnit === true;
    });

  // 스토어 레벨 판매단위가 필요하면 자동 생성
  if (needsStoreLevelUnit) {
    const store = database.stores.find((s) => s.id === storeId);
    const existing = database.canonicalSalesUnits.find(
      (u) => u.storeId === storeId && u.isStoreLevel === true,
    );

    if (store && !existing) {
      database.canonicalSalesUnits.push({
        id: createId(),
        storeId,
        displayName: "스토어 전체 광고비",
        matchAliases: [],
        normalizedMatchAliases: [],
        linkedProductIds: [],
        linkedOptionCodes: [],
        linkedManageCodes: [],
        memo: "자동 생성된 스토어 전체 광고비 판매단위",
        isActive: true,
        deactivatedAt: null,
        isStoreLevel: true,
        parentSalesUnitId: null,
        isGroup: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
  }

  // 매핑 재계산 (필요시 새로 생성된 스토어 레벨 판매단위를 사용)
  database.adCampaignDailyCosts
    .filter((item) => item.storeId === storeId)
    .forEach((item) => {
      const mapping = evaluateAdMapping(database, storeId, item.normalizedCampaignName, getAdMappingOverride(item));

      // needsStoreLevelUnit이 true인 경우, 스토어 레벨 판매단위 ID를 찾아 매핑
      if (mapping.needsStoreLevelUnit === true) {
        const storeLevelUnit = database.canonicalSalesUnits.find(
          (u) => u.storeId === storeId && u.isStoreLevel === true,
        );
        item.canonicalSalesUnitId = storeLevelUnit?.id ?? null;
      } else {
        item.canonicalSalesUnitId = mapping.canonicalSalesUnitId;
      }

      item.matchedRuleCount = mapping.matchedRuleCount;
      item.mappingReason = mapping.mappingReason;
      item.reasonNote = mapping.reasonNote;
      item.reasonNoteInherited = mapping.reasonNoteInherited;
      item.updatedAt = new Date().toISOString();
    });
};

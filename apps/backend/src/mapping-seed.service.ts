import { Injectable } from "@nestjs/common";
import { CanonicalSalesUnit, normalizeMatchAlias, normalizeText } from "@patima/shared";
import { recalculateAdMappingsForStore } from "./ad-mapping-engine";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import {
  createId,
  ensureStoreExists,
  formatApiSuccess,
  nowIso,
  sanitizeMatchAliases,
  normalizeMatchAliasList,
} from "./helpers";
import { recalculateOrderMappingsForStore } from "./sales-unit-auto-mapper";
import { StoreService } from "./store.service";

interface MappingSeedResult {
  createdCount: number;
  mergedCount: number;
  totalProcessed: number;
  details: {
    type: "CREATED" | "MERGED";
    salesUnitId: string;
    displayName: string;
    linkedProductIds: string[];
    linkedOptionCodes: string[];
    linkedManageCodes?: string[];
  }[];
}

/** 일반 상품: externalProductId 단위로 그룹핑 */
interface RegularProductGroup {
  externalProductId: string;
  /** 그룹 내 가장 긴(=가장 정보가 많은) rawProductName을 대표명으로 사용 */
  bestRawProductName: string;
  productIds: Set<string>;
}

/** 함께배송 상품: 파싱된 카테고리 단위로 그룹핑 */
interface BundledCategoryGroup {
  category: string;
  optionCodes: Set<string>;
  manageCodes: Set<string>;
  /** 함께배송 파싱 실패 시 fallback 용 */
  rawProductNames: Set<string>;
}

@Injectable()
export class MappingSeedService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storeService: StoreService,
    private readonly auditLogService: AuditLogService,
  ) {}

  generateInitialMappings(storeId: string): MappingSeedResult {
    this.storeService.ensureWritable(storeId);
    ensureStoreExists(this.databaseService.getSnapshot(), storeId);

    const snapshot = this.databaseService.getSnapshot();
    const orderItems = snapshot.orderItems.filter((item) => item.storeId === storeId);

    if (orderItems.length === 0) {
      return { createdCount: 0, mergedCount: 0, totalProcessed: 0, details: [] };
    }

    const validItems = orderItems.filter((item) => item.externalProductId != null);
    if (validItems.length === 0) {
      return { createdCount: 0, mergedCount: 0, totalProcessed: 0, details: [] };
    }

    // ──────────────────────────────────────────────
    // Step 0: 기존 자동 생성 판매단위 초기화 (멱등성 보장)
    //         수동 확인(confirmedAt)된 시그니처의 매핑은 보존
    // ──────────────────────────────────────────────
    this.databaseService.write((draft) => {
      const beforeCount = draft.canonicalSalesUnits.length;
      draft.canonicalSalesUnits = draft.canonicalSalesUnits.filter(
        (unit) => unit.storeId !== storeId,
      );
      const removedCount = beforeCount - draft.canonicalSalesUnits.length;
      if (removedCount > 0) {
        console.log(`[MappingSeed] Cleared ${removedCount} existing sales units for store ${storeId}`);
      }

      // 기존 주문 아이템의 매핑도 초기화 (confirmed 시그니처 제외)
      draft.orderItems
        .filter((item) => item.storeId === storeId)
        .forEach((item) => {
          item.canonicalSalesUnitId = null;
        });

      // 미확인 시그니처의 매핑도 초기화
      draft.orderSourceSignatures
        .filter((sig) => sig.storeId === storeId && !sig.confirmedAt)
        .forEach((sig) => {
          sig.canonicalSalesUnitId = null;
          sig.mappingStatus = "UNMAPPED";
        });
    });

    // ──────────────────────────────────────────────
    // Step 1: 함께배송 / 일반 상품 분리 후 각각 그룹핑
    // ──────────────────────────────────────────────

    /** 일반 상품: externalProductId 단위로만 그룹핑 (색상/사이즈 구분 불필요) */
    const regularGroups = new Map<string, RegularProductGroup>();

    /** 함께배송 상품: 파싱된 카테고리명 단위로 그룹핑 */
    const bundledGroups = new Map<string, BundledCategoryGroup>();

    /** 함께배송 파싱 실패 아이템 → 일반 그룹으로 합류 */
    const bundledParseFailures: Array<{ externalProductId: string; rawOptionInfo: string; rawProductName: string; productId: string | null }> = [];

    validItems.forEach((item) => {
      const externalProductId = item.externalProductId!;
      const isShippedTogether = item.rawOptionInfo?.includes("[함께배송");

      if (isShippedTogether && item.rawOptionInfo) {
        const parsed = this.parseShippedTogetherOption(item.rawOptionInfo);

        if (parsed.length > 0) {
          parsed.forEach(({ category }) => {
            // 정규화된 키로 그룹핑 (공백/FREE/사이즈 접미사 차이 무시)
            const normalizedKey = this.normalizeBundledCategory(category);
            if (!bundledGroups.has(normalizedKey)) {
              bundledGroups.set(normalizedKey, {
                category: category.trim(), // 표시명은 원본 유지
                optionCodes: new Set(),
                manageCodes: new Set(),
                rawProductNames: new Set(),
              });
            }
            const group = bundledGroups.get(normalizedKey)!;
            // 실제 네이버 optionCode를 저장해야 auto-mapper가 매칭 가능
            // (파싱된 텍스트값 "블랙"이 아닌 네이버 숫자 코드 "3327191532")
            if (item.optionCode) group.optionCodes.add(item.optionCode);
            // optionManageCode가 있으면 관리코드도 저장
            if (item.optionManageCode) {
              group.manageCodes.add(item.optionManageCode);
            }
            group.rawProductNames.add(item.rawProductName);
          });
        } else {
          // 파싱 실패 → 일반 상품 그룹으로 fallback
          console.warn(`[MappingSeed] Failed to parse 함께배송 pattern: ${item.rawOptionInfo}`);
          bundledParseFailures.push({
            externalProductId,
            rawOptionInfo: item.rawOptionInfo,
            rawProductName: item.rawProductName,
            productId: item.productId,
          });
        }
      } else {
        // 일반 상품: externalProductId로만 그룹핑
        if (!regularGroups.has(externalProductId)) {
          regularGroups.set(externalProductId, {
            externalProductId,
            bestRawProductName: item.rawProductName,
            productIds: new Set(),
          });
        }
        const group = regularGroups.get(externalProductId)!;
        // linkedProductIds는 externalProductId를 저장해야 auto-mapper가 매칭 가능
        group.productIds.add(externalProductId);
        // 가장 긴 이름을 대표명으로 (프로모션 문구 제거 전 기준)
        if (item.rawProductName.length > group.bestRawProductName.length) {
          group.bestRawProductName = item.rawProductName;
        }
      }
    });

    // 함께배송 파싱 실패 아이템은 일반 그룹에 합류
    bundledParseFailures.forEach((item) => {
      if (!regularGroups.has(item.externalProductId)) {
        regularGroups.set(item.externalProductId, {
          externalProductId: item.externalProductId,
          bestRawProductName: item.rawProductName,
          productIds: new Set(),
        });
      }
      const group = regularGroups.get(item.externalProductId)!;
      group.productIds.add(item.externalProductId);
    });

    // ──────────────────────────────────────────────
    // Step 2: 판매단위 생성/병합
    // ──────────────────────────────────────────────

    const result: MappingSeedResult = {
      createdCount: 0,
      mergedCount: 0,
      totalProcessed: 0,
      details: [],
    };

    this.databaseService.write((draft) => {
      // 2-A: 일반 상품 처리 (externalProductId 기반)
      regularGroups.forEach((group) => {
        const displayName = this.extractProductDisplayName(group.bestRawProductName);
        const productIds = Array.from(group.productIds);
        const existing = this.findExistingSalesUnit(draft, storeId, displayName);

        if (existing) {
          const uniqueProductIds = Array.from(
            new Set([...existing.linkedProductIds, ...productIds]),
          );
          existing.linkedProductIds = uniqueProductIds;
          existing.updatedAt = nowIso();
          result.mergedCount++;
          result.details.push({
            type: "MERGED",
            salesUnitId: existing.id,
            displayName: existing.displayName,
            linkedProductIds: existing.linkedProductIds,
            linkedOptionCodes: existing.linkedOptionCodes,
            linkedManageCodes: existing.linkedManageCodes,
          });
        } else {
          // ID 기반 매핑만 사용 — matchAliases 비워서 텍스트 충돌 방지
          const newUnit = this.createSalesUnit(
            storeId,
            displayName,
            productIds,
            [],
            [], // 텍스트 매칭 비활성화: ID 기반(linkedProductIds)으로만 매핑
          );
          draft.canonicalSalesUnits.push(newUnit);
          result.createdCount++;
          result.details.push({
            type: "CREATED",
            salesUnitId: newUnit.id,
            displayName: newUnit.displayName,
            linkedProductIds: newUnit.linkedProductIds,
            linkedOptionCodes: newUnit.linkedOptionCodes,
            linkedManageCodes: newUnit.linkedManageCodes,
          });
        }
      });

      // 2-B: 함께배송 상품 처리 (카테고리 기반)
      bundledGroups.forEach((group) => {
        const displayName = group.category;
        const optionCodes = Array.from(group.optionCodes);
        const manageCodes = Array.from(group.manageCodes);
        const existing = this.findExistingSalesUnit(draft, storeId, displayName, manageCodes);

        if (existing) {
          const uniqueOptionCodes = Array.from(
            new Set([...existing.linkedOptionCodes, ...optionCodes]),
          );
          const uniqueManageCodes = manageCodes.length > 0
            ? Array.from(new Set([...existing.linkedManageCodes, ...manageCodes]))
            : existing.linkedManageCodes;
          existing.linkedOptionCodes = uniqueOptionCodes;
          if (manageCodes.length > 0) {
            existing.linkedManageCodes = uniqueManageCodes;
          }
          existing.updatedAt = nowIso();
          result.mergedCount++;
          result.details.push({
            type: "MERGED",
            salesUnitId: existing.id,
            displayName: existing.displayName,
            linkedProductIds: existing.linkedProductIds,
            linkedOptionCodes: existing.linkedOptionCodes,
            linkedManageCodes: existing.linkedManageCodes,
          });
        } else {
          // ID 기반 매핑만 사용 — matchAliases 비워서 텍스트 충돌 방지
          const newUnit = this.createSalesUnit(
            storeId,
            displayName,
            [],
            optionCodes,
            [], // 텍스트 매칭 비활성화: ID 기반(linkedOptionCodes)으로만 매핑
            manageCodes.length > 0 ? manageCodes : undefined,
          );
          draft.canonicalSalesUnits.push(newUnit);
          result.createdCount++;
          result.details.push({
            type: "CREATED",
            salesUnitId: newUnit.id,
            displayName: newUnit.displayName,
            linkedProductIds: newUnit.linkedProductIds,
            linkedOptionCodes: newUnit.linkedOptionCodes,
            linkedManageCodes: newUnit.linkedManageCodes,
          });
        }
      });

      // Recalculate mappings for the store
      recalculateOrderMappingsForStore(draft, storeId);
      recalculateAdMappingsForStore(draft, storeId);
    });

    result.totalProcessed = regularGroups.size + bundledGroups.size;

    this.auditLogService.record({
      storeId,
      domain: "MAPPING_SEED",
      action: "GENERATE_INITIAL_MAPPINGS",
      targetId: null,
      actorIdentifier: "LOCALHOST_ADMIN",
      beforeJson: { regularCount: regularGroups.size, bundledCount: bundledGroups.size },
      afterJson: result,
    });

    return result;
  }

  /**
   * 함께배송 카테고리명 정규화
   * - 공백 제거: "러닝 모자" → "러닝모자"
   * - 대소문자 통일 (lowercase)
   * - FREE/사이즈 접미사 제거: "러닝모자FREE" → "러닝모자", "조끼XL" → "조끼"
   * - 앞뒤 공백 제거
   */
  private normalizeBundledCategory(category: string): string {
    return category
      .trim()
      .replace(/\s+/g, "")              // 모든 공백 제거
      .replace(/FREE$/i, "")            // FREE 접미사 제거
      .replace(/(XS|S|M|L|XL|XXL|2XL|3XL)$/i, "") // 사이즈 접미사 제거
      .toLowerCase();
  }

  private parseShippedTogetherOption(
    rawOptionInfo: string,
  ): Array<{ category: string; optionCodes: string[] }> {
    // Pattern: [함께배송 ...) ...카테고리: ...
    // Example: "[함께배송] 의류: 파랑색"
    const regex = /\[함께배송[^\]]*\]\s*(.+?)[:：]\s*(.+)/g;
    const matches: Array<{ category: string; optionCodes: string[] }> = [];
    let match;

    while ((match = regex.exec(rawOptionInfo)) !== null) {
      const category = match[1].trim();
      const optionValue = match[2].trim();

      if (category && optionValue) {
        matches.push({
          category,
          optionCodes: [optionValue],
        });
      }
    }

    return matches;
  }

  private extractProductDisplayName(rawProductName: string): string {
    // 1차: 프로모션/이벤트 접두어만 제거 (예: "[런칭 60%할인]", "(추천)")
    //      대괄호/소괄호 안의 내용이 상품명 자체인 경우를 보호하기 위해
    //      제거 후 결과가 너무 짧으면(4자 미만) 원본을 유지
    const withoutPromoPrefix = rawProductName
      .replace(/^[\[\(][^\]\)]*[\]\)]\s*/g, "") // 맨 앞의 대괄호/소괄호만 제거
      .trim();

    if (withoutPromoPrefix.length >= 4) {
      return withoutPromoPrefix;
    }

    // 2차: 접두어 제거 결과가 너무 짧으면 원본 사용
    return rawProductName.trim();
  }

  private createSalesUnit(
    storeId: string,
    displayName: string,
    linkedProductIds: string[],
    linkedOptionCodes: string[],
    customMatchAliases?: string[],
    linkedManageCodes?: string[],
  ): CanonicalSalesUnit {
    const matchAliases = customMatchAliases ? customMatchAliases : [displayName];
    const normalizedMatchAliases = normalizeMatchAliasList(matchAliases);

    const unit: CanonicalSalesUnit = {
      id: createId(),
      storeId,
      displayName,
      matchAliases,
      normalizedMatchAliases,
      linkedProductIds,
      linkedOptionCodes,
      linkedManageCodes: linkedManageCodes || [],
      memo: null,
      isActive: true,
      deactivatedAt: null,
      isStoreLevel: false,
      parentSalesUnitId: null,
      isGroup: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    return unit;
  }

  private findExistingSalesUnit(
    database: any,
    storeId: string,
    displayName: string,
    linkedManageCodes?: string[],
  ): CanonicalSalesUnit | null {
    return (
      database.canonicalSalesUnits.find(
        (unit: CanonicalSalesUnit) => {
          const storeAndNameMatch =
            unit.storeId === storeId &&
            unit.displayName.toLowerCase() === displayName.toLowerCase();

          // Secondary matcher: if linkedManageCodes provided, require overlap with existing
          if (storeAndNameMatch && linkedManageCodes && linkedManageCodes.length > 0) {
            const hasOverlap = linkedManageCodes.some((code) =>
              unit.linkedManageCodes.includes(code),
            );
            return hasOverlap;
          }

          return storeAndNameMatch;
        },
      ) ?? null
    );
  }
}

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { CanonicalSalesUnit, normalizeMatchAlias, normalizeText } from "@patima/shared";
import { recalculateAdMappingsForStore } from "./ad-mapping-engine";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import {
  assertGroupInvariants,
  createId,
  ensureNormalizedLength,
  ensureStoreExists,
  formatApiSuccess,
  normalizeMatchAliasList,
  nowIso,
  paginate,
  sanitizeMatchAliases,
} from "./helpers";
import { ProfitSummaryService } from "./profit-summary.service";
import { recalculateOrderMappingsForStore } from "./sales-unit-auto-mapper";
import { StoreService } from "./store.service";

interface SalesUnitPayload {
  storeId: string;
  displayName: string;
  matchAliases?: string[] | null;
  linkedProductIds?: string[] | null;
  linkedOptionCodes?: string[] | null;
  memo?: string | null;
}

interface SalesUnitCreateOptions {
  skipOrderRecalculation?: boolean;
  skipAdRecalculation?: boolean;
  skipProfitSummaryRecalculation?: boolean;
}

@Injectable()
export class SalesUnitService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storeService: StoreService,
    private readonly auditLogService: AuditLogService,
    private readonly profitSummaryService?: ProfitSummaryService,
  ) {}

  /**
   * 스토어 전체 광고비 판매단위를 확인하고 없으면 자동 생성
   * 스토어당 1개만 존재해야 함
   */
  async ensureStoreLevelSalesUnit(storeId: string): Promise<string> {
    const snapshot = this.databaseService.getSnapshot();
    const store = snapshot.stores.find((s) => s.id === storeId);
    if (!store) {
      throw new Error(`Store ${storeId} not found`);
    }

    // 기존 스토어 레벨 판매단위 확인
    const existing = snapshot.canonicalSalesUnits.find(
      (u) => u.storeId === storeId && u.isStoreLevel === true,
    );

    if (existing) {
      return existing.id;
    }

    // 없으면 자동 생성
    const displayName = "스토어 전체 광고비";
    const newUnit: CanonicalSalesUnit = {
      id: createId(),
      storeId,
      displayName,
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
    };

    await this.databaseService.writeCommitted((draft) => {
      draft.canonicalSalesUnits.push(newUnit);
      this.auditLogService.appendToDraft(draft, {
        storeId,
        domain: "SALES_UNIT",
        action: "CREATE_STORE_LEVEL",
        targetId: newUnit.id,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: null,
        afterJson: newUnit,
      });
    });

    return newUnit.id;
  }

  list(storeId: string, q?: string, page?: number, pageSize?: number) {
    const keyword = q ? normalizeText(q) : null;
    const aliasKeyword = q ? normalizeMatchAlias(q) : null;
    const items = this.databaseService
      .getSnapshot()
      .canonicalSalesUnits.filter((item) => item.storeId === storeId)
      .filter((item) =>
        keyword
          ? normalizeText(item.displayName).includes(keyword) ||
            item.matchAliases.some((alias) => normalizeText(alias).includes(keyword)) ||
            (!!aliasKeyword && item.normalizedMatchAliases.some((alias) => alias.includes(aliasKeyword)))
          : true,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    return formatApiSuccess(paginate(items, page, pageSize));
  }

  async create(payload: SalesUnitPayload, options?: SalesUnitCreateOptions) {
    this.storeService.ensureWritable(payload.storeId);
    const displayName = payload.displayName.trim();
    const matchAliases = sanitizeMatchAliases(payload.matchAliases ?? []);
    ensureNormalizedLength(normalizeText(displayName), "displayName");
    const timestamp = nowIso();

    const created: CanonicalSalesUnit = {
      id: createId(),
      storeId: payload.storeId,
      displayName,
      matchAliases,
      normalizedMatchAliases: normalizeMatchAliasList(matchAliases),
      linkedProductIds: payload.linkedProductIds ?? [],
      linkedOptionCodes: payload.linkedOptionCodes ?? [],
      linkedManageCodes: [],
      memo: payload.memo ?? null,
      isActive: true,
      deactivatedAt: null,
      isStoreLevel: false,
      parentSalesUnitId: null,
      isGroup: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.ensureUnique(created);
    assertGroupInvariants(created);

    const shouldRecalculateOrders = !options?.skipOrderRecalculation;
    const shouldRecalculateAds = !options?.skipAdRecalculation;
    const shouldUseDirectCreate =
      this.databaseService.getStorageMode() === "postgres" &&
      !shouldRecalculateOrders &&
      !shouldRecalculateAds;

    if (shouldUseDirectCreate) {
      const auditLog = this.auditLogService.createAuditLog({
        storeId: payload.storeId,
        domain: "SALES_UNIT",
        action: "CREATE",
        targetId: created.id,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: null,
        afterJson: created,
      });
      await this.databaseService.createCanonicalSalesUnitCommitted({
        salesUnit: created,
        auditLog,
      });
    } else {
      await this.databaseService.writeCommitted((draft) => {
        ensureStoreExists(draft, payload.storeId);
        draft.canonicalSalesUnits.push(created);
        if (shouldRecalculateOrders) {
          recalculateOrderMappingsForStore(draft, payload.storeId);
        }
        if (shouldRecalculateAds) {
          recalculateAdMappingsForStore(draft, payload.storeId);
        }
        this.auditLogService.appendToDraft(draft, {
          storeId: payload.storeId,
          domain: "SALES_UNIT",
          action: "CREATE",
          targetId: created.id,
          actorIdentifier: "LOCALHOST_ADMIN",
          beforeJson: null,
          afterJson: created,
        });
      });
    }

    if (!options?.skipProfitSummaryRecalculation) {
      await this.recalculateProfitSummariesForStore(payload.storeId);
    }

    return formatApiSuccess(created);
  }

  async update(salesUnitId: string, payload: Omit<SalesUnitPayload, "storeId">) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.canonicalSalesUnits.find((item) => item.id === salesUnitId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "판매단위를 찾을 수 없습니다.",
        errors: [{ field: "salesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);

    const displayName = payload.displayName.trim();
    const matchAliases = sanitizeMatchAliases(payload.matchAliases ?? []);
    ensureNormalizedLength(normalizeText(displayName), "displayName");

    const updated: CanonicalSalesUnit = {
      ...existing,
      displayName,
      matchAliases,
      normalizedMatchAliases: normalizeMatchAliasList(matchAliases),
      linkedProductIds: payload.linkedProductIds ?? existing.linkedProductIds ?? [],
      linkedOptionCodes: payload.linkedOptionCodes ?? existing.linkedOptionCodes ?? [],
      memo: payload.memo ?? null,
      updatedAt: nowIso(),
    };
    this.ensureUnique(updated, salesUnitId);
    assertGroupInvariants(updated);

    await this.databaseService.writeCommitted((draft) => {
      const target = draft.canonicalSalesUnits.find((item) => item.id === salesUnitId)!;
      Object.assign(target, updated);
      recalculateOrderMappingsForStore(draft, existing.storeId);
      recalculateAdMappingsForStore(draft, existing.storeId);
      this.auditLogService.appendToDraft(draft, {
        storeId: existing.storeId,
        domain: "SALES_UNIT",
        action: "UPDATE",
        targetId: salesUnitId,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: existing,
        afterJson: updated,
      });
    });
    await this.recalculateProfitSummariesForStore(existing.storeId);

    return formatApiSuccess(updated);
  }

  async deactivate(salesUnitId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.canonicalSalesUnits.find((item) => item.id === salesUnitId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "판매단위를 찾을 수 없습니다.",
        errors: [{ field: "salesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);

    await this.databaseService.writeCommitted((draft) => {
      const target = draft.canonicalSalesUnits.find((item) => item.id === salesUnitId)!;
      target.isActive = false;
      target.deactivatedAt = nowIso();
      target.updatedAt = nowIso();
      // 비활성 유닛을 가리키는 시그니처 매핑 해제 (stale fallback 방지)
      draft.orderSourceSignatures
        .filter((s) => s.canonicalSalesUnitId === salesUnitId)
        .forEach((s) => {
          s.canonicalSalesUnitId = null;
        });
      recalculateOrderMappingsForStore(draft, existing.storeId);
      recalculateAdMappingsForStore(draft, existing.storeId);
    });
    await this.recalculateProfitSummariesForStore(existing.storeId);

    return formatApiSuccess({
      salesUnitId,
      isActive: false,
      deactivatedAt: nowIso(),
    });
  }

  async activate(salesUnitId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.canonicalSalesUnits.find((item) => item.id === salesUnitId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "판매단위를 찾을 수 없습니다.",
        errors: [{ field: "salesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);

    await this.databaseService.writeCommitted((draft) => {
      const target = draft.canonicalSalesUnits.find((item) => item.id === salesUnitId)!;
      target.isActive = true;
      target.deactivatedAt = null;
      target.updatedAt = nowIso();
      recalculateOrderMappingsForStore(draft, existing.storeId);
      recalculateAdMappingsForStore(draft, existing.storeId);
    });
    await this.recalculateProfitSummariesForStore(existing.storeId);

    return formatApiSuccess({
      salesUnitId,
      isActive: true,
      reactivatedAt: nowIso(),
    });
  }

  /**
   * 판매단위 그룹 생성
   * isGroup: true 부모를 만들고, 자식들의 parentSalesUnitId를 새 그룹 ID로 설정
   */
  createSalesUnitGroup(
    storeId: string,
    displayName: string,
    childSalesUnitIds: string[],
  ) {
    this.storeService.ensureWritable(storeId);
    const snapshot = this.databaseService.getSnapshot();

    // 검증: 자식 ID 배열이 비어있지 않은가
    if (!childSalesUnitIds || childSalesUnitIds.length === 0) {
      throw new BadRequestException({
        success: false,
        message: "최소 1개 이상의 자식 판매단위를 지정해야 합니다.",
        errors: [{ field: "childSalesUnitIds", reason: "EMPTY_CHILD_SALES_UNIT_IDS" }],
      });
    }

    // 검증: 자식 ID에 중복이 없는가
    if (new Set(childSalesUnitIds).size !== childSalesUnitIds.length) {
      throw new BadRequestException({
        success: false,
        message: "자식 판매단위 ID에 중복이 있습니다.",
        errors: [{ field: "childSalesUnitIds", reason: "DUPLICATE_CHILD_SALES_UNIT_IDS" }],
      });
    }

    // 검증: 모든 자식이 동일 storeId인가
    const childUnits = childSalesUnitIds.map((id) => {
      const unit = snapshot.canonicalSalesUnits.find((u) => u.id === id);
      if (!unit) {
        throw new NotFoundException({
          success: false,
          message: `자식 판매단위 ${id}를 찾을 수 없습니다.`,
          errors: [{ field: "childSalesUnitIds", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
        });
      }
      if (unit.storeId !== storeId) {
        throw new BadRequestException({
          success: false,
          message: "모든 자식 판매단위는 동일한 스토어에 속해야 합니다.",
          errors: [{ field: "childSalesUnitIds", reason: "CROSS_STORE_REFERENCE" }],
        });
      }
      return unit;
    });

    // 검증: 자식 중 이미 parentSalesUnitId != null인 것이 없는가
    const alreadyGrouped = childUnits.find((u) => u.parentSalesUnitId);
    if (alreadyGrouped) {
      throw new BadRequestException({
        success: false,
        message: `자식 판매단위 ${alreadyGrouped.id}는 이미 다른 그룹에 속해있습니다.`,
        errors: [{ field: "childSalesUnitIds", reason: "ALREADY_GROUPED" }],
      });
    }

    // 검증: 자식이 isGroup: true가 아닌가
    const childGroup = childUnits.find((u) => u.isGroup);
    if (childGroup) {
      throw new BadRequestException({
        success: false,
        message: `자식 판매단위 ${childGroup.id}는 그룹일 수 없습니다.`,
        errors: [{ field: "childSalesUnitIds", reason: "CHILD_CANNOT_BE_GROUP" }],
      });
    }

    // 검증: 자식이 isStoreLevel: true가 아닌가
    const childStoreLevel = childUnits.find((u) => u.isStoreLevel);
    if (childStoreLevel) {
      throw new BadRequestException({
        success: false,
        message: `자식 판매단위 ${childStoreLevel.id}는 스토어 레벨일 수 없습니다.`,
        errors: [{ field: "childSalesUnitIds", reason: "CHILD_CANNOT_BE_STORE_LEVEL" }],
      });
    }

    const groupId = createId();
    const groupUnit: CanonicalSalesUnit = {
      id: groupId,
      storeId,
      displayName: displayName.trim(),
      matchAliases: [],
      normalizedMatchAliases: [],
      linkedProductIds: [],
      linkedOptionCodes: [],
      linkedManageCodes: [],
      memo: null,
      isActive: true,
      deactivatedAt: null,
      isStoreLevel: false,
      parentSalesUnitId: null,
      isGroup: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    assertGroupInvariants(groupUnit);

    return this.createSalesUnitGroupCommitted(storeId, groupId, groupUnit, childSalesUnitIds);
  }

  private async createSalesUnitGroupCommitted(
    storeId: string,
    groupId: string,
    groupUnit: CanonicalSalesUnit,
    childSalesUnitIds: string[],
  ) {
    await this.databaseService.writeCommitted((draft) => {
      ensureStoreExists(draft, storeId);
      draft.canonicalSalesUnits.push(groupUnit);

      // 자식들의 parentSalesUnitId 업데이트
      childSalesUnitIds.forEach((childId) => {
        const child = draft.canonicalSalesUnits.find((u) => u.id === childId);
        if (child) {
          child.parentSalesUnitId = groupId;
          child.updatedAt = nowIso();
        }
      });

      // 광고 매핑 승계: 자식에 연결되어 있던 매핑을 그룹으로 마이그레이션
      childSalesUnitIds.forEach((childId) => {
        const childMappings = draft.campaignMappings.filter(
          (m) => m.storeId === storeId && m.canonicalSalesUnitId === childId && m.isActive,
        );
        childMappings.forEach((m) => {
          m.canonicalSalesUnitId = groupId;
          m.updatedAt = nowIso();
        });
      });

      // 광고 다시 계산
      recalculateAdMappingsForStore(draft, storeId);
      this.auditLogService.appendToDraft(draft, {
        storeId,
        domain: "SALES_UNIT",
        action: "SALES_UNIT_GROUP_CREATED",
        targetId: groupId,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: null,
        afterJson: groupUnit,
      });
    });
    await this.recalculateProfitSummariesForStore(storeId);

    return formatApiSuccess(groupUnit);
  }

  /**
   * 기존 그룹에 자식 추가
   */
  async attachChildToGroup(storeId: string, groupId: string, childId: string) {
    this.storeService.ensureWritable(storeId);
    const snapshot = this.databaseService.getSnapshot();

    const group = snapshot.canonicalSalesUnits.find((u) => u.id === groupId);
    if (!group) {
      throw new NotFoundException({
        success: false,
        message: "그룹 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "groupId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }

    if (!group.isGroup) {
      throw new BadRequestException({
        success: false,
        message: "대상 판매단위는 그룹이 아닙니다.",
        errors: [{ field: "groupId", reason: "NOT_A_GROUP" }],
      });
    }

    const child = snapshot.canonicalSalesUnits.find((u) => u.id === childId);
    if (!child) {
      throw new NotFoundException({
        success: false,
        message: "자식 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "childId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }

    if (child.storeId !== storeId) {
      throw new BadRequestException({
        success: false,
        message: "자식 판매단위는 동일한 스토어에 속해야 합니다.",
        errors: [{ field: "childId", reason: "CROSS_STORE_REFERENCE" }],
      });
    }

    if (child.parentSalesUnitId) {
      throw new BadRequestException({
        success: false,
        message: "자식 판매단위는 이미 다른 그룹에 속해있습니다.",
        errors: [{ field: "childId", reason: "ALREADY_GROUPED" }],
      });
    }

    if (child.isGroup) {
      throw new BadRequestException({
        success: false,
        message: "자식 판매단위는 그룹일 수 없습니다.",
        errors: [{ field: "childId", reason: "CHILD_CANNOT_BE_GROUP" }],
      });
    }

    if (child.isStoreLevel) {
      throw new BadRequestException({
        success: false,
        message: "자식 판매단위는 스토어 레벨일 수 없습니다.",
        errors: [{ field: "childId", reason: "CHILD_CANNOT_BE_STORE_LEVEL" }],
      });
    }

    const before = { ...child };

    await this.databaseService.writeCommitted((draft) => {
      const targetChild = draft.canonicalSalesUnits.find((u) => u.id === childId)!;
      targetChild.parentSalesUnitId = groupId;
      targetChild.updatedAt = nowIso();

      // 광고 매핑 승계
      const childMappings = draft.campaignMappings.filter(
        (m) => m.storeId === storeId && m.canonicalSalesUnitId === childId && m.isActive,
      );
      childMappings.forEach((m) => {
        m.canonicalSalesUnitId = groupId;
        m.updatedAt = nowIso();
      });

      recalculateAdMappingsForStore(draft, storeId);
      this.auditLogService.appendToDraft(draft, {
        storeId,
        domain: "SALES_UNIT",
        action: "SALES_UNIT_GROUP_CHILD_ATTACHED",
        targetId: groupId,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: before,
        afterJson: { ...child, parentSalesUnitId: groupId },
      });
    });
    await this.recalculateProfitSummariesForStore(storeId);

    return formatApiSuccess({ groupId, childId });
  }

  /**
   * 자식을 그룹에서 제거
   */
  async detachChildFromGroup(storeId: string, childId: string) {
    this.storeService.ensureWritable(storeId);
    const snapshot = this.databaseService.getSnapshot();

    const child = snapshot.canonicalSalesUnits.find((u) => u.id === childId);
    if (!child) {
      throw new NotFoundException({
        success: false,
        message: "자식 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "childId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }

    if (child.storeId !== storeId) {
      throw new BadRequestException({
        success: false,
        message: "자식 판매단위는 동일한 스토어에 속해야 합니다.",
        errors: [{ field: "childId", reason: "CROSS_STORE_REFERENCE" }],
      });
    }

    if (!child.parentSalesUnitId) {
      throw new BadRequestException({
        success: false,
        message: "자식 판매단위는 그룹에 속해있지 않습니다.",
        errors: [{ field: "childId", reason: "NOT_IN_GROUP" }],
      });
    }

    const before = { ...child };
    const parentId = child.parentSalesUnitId;

    await this.databaseService.writeCommitted((draft) => {
      const targetChild = draft.canonicalSalesUnits.find((u) => u.id === childId)!;
      targetChild.parentSalesUnitId = null;
      targetChild.updatedAt = nowIso();
      // 광고 매핑은 건드리지 않음 (그룹에 남음)
      this.auditLogService.appendToDraft(draft, {
        storeId,
        domain: "SALES_UNIT",
        action: "SALES_UNIT_GROUP_CHILD_DETACHED",
        targetId: parentId,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: before,
        afterJson: { ...child, parentSalesUnitId: null },
      });
    });
    await this.recalculateProfitSummariesForStore(storeId);

    return formatApiSuccess({ childId, parentId });
  }

  /**
   * 그룹 해체
   */
  async dissolveGroup(storeId: string, groupId: string) {
    this.storeService.ensureWritable(storeId);
    const snapshot = this.databaseService.getSnapshot();

    const group = snapshot.canonicalSalesUnits.find((u) => u.id === groupId);
    if (!group) {
      throw new NotFoundException({
        success: false,
        message: "그룹 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "groupId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }

    if (!group.isGroup) {
      throw new BadRequestException({
        success: false,
        message: "대상 판매단위는 그룹이 아닙니다.",
        errors: [{ field: "groupId", reason: "NOT_A_GROUP" }],
      });
    }

    if (group.storeId !== storeId) {
      throw new BadRequestException({
        success: false,
        message: "그룹 판매단위는 동일한 스토어에 속해야 합니다.",
        errors: [{ field: "groupId", reason: "CROSS_STORE_REFERENCE" }],
      });
    }

    await this.databaseService.writeCommitted((draft) => {
      // 자식들의 parentSalesUnitId 복구
      draft.canonicalSalesUnits
        .filter((u) => u.parentSalesUnitId === groupId)
        .forEach((child) => {
          child.parentSalesUnitId = null;
          child.updatedAt = nowIso();
        });

      // 광고 매핑: 그룹에 연결되어 있던 매핑을 INTENTIONALLY_UNMAPPED로 변환
      const groupMappings = draft.campaignMappings.filter(
        (m) => m.storeId === storeId && m.canonicalSalesUnitId === groupId && m.isActive,
      );
      groupMappings.forEach((m) => {
        m.isActive = false;
        m.deactivatedAt = nowIso();
        m.updatedAt = nowIso();
      });

      // 그룹에 연결된 광고 비용을 INTENTIONALLY_UNMAPPED로 표시
      draft.adCampaignDailyCosts
        .filter((item) => item.storeId === storeId && item.canonicalSalesUnitId === groupId)
        .forEach((item) => {
          item.canonicalSalesUnitId = null;
          item.mappingReason = "INTENTIONALLY_UNMAPPED";
          item.reasonNote = "그룹이 해체되어 매핑이 해제되었습니다.";
          item.updatedAt = nowIso();
        });

      // 그룹 자체도 deactivate
      const targetGroup = draft.canonicalSalesUnits.find((u) => u.id === groupId)!;
      targetGroup.isActive = false;
      targetGroup.deactivatedAt = nowIso();
      targetGroup.updatedAt = nowIso();
      this.auditLogService.appendToDraft(draft, {
        storeId,
        domain: "SALES_UNIT",
        action: "SALES_UNIT_GROUP_DISSOLVED",
        targetId: groupId,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: group,
        afterJson: { ...group, isActive: false, deactivatedAt: nowIso() },
      });
    });
    await this.recalculateProfitSummariesForStore(storeId);

    return formatApiSuccess({ groupId });
  }

  private async recalculateProfitSummariesForStore(storeId: string) {
    await this.profitSummaryService?.refreshStoreDatesSinceBestEffort({
      storeId,
      dateFrom: "0001-01-01",
      reason: "MAPPING_CHANGE",
    });
  }

  private ensureUnique(target: CanonicalSalesUnit, excludeId?: string) {
    const snapshot = this.databaseService.getSnapshot();
    const duplicatedDisplay = snapshot.canonicalSalesUnits.some(
      (item) =>
        item.id !== excludeId &&
        item.storeId === target.storeId &&
        normalizeText(item.displayName) === normalizeText(target.displayName),
    );
    if (duplicatedDisplay) {
      throw new BadRequestException({
        success: false,
        message: "중복된 판매단위명이 있습니다.",
        errors: [{ field: "displayName", reason: "SALES_UNIT_DUPLICATE_DISPLAY_NAME" }],
      });
    }

    const duplicatedAlias = target.normalizedMatchAliases.find((alias) =>
      snapshot.canonicalSalesUnits.some(
        (item) =>
          item.id !== excludeId &&
          item.storeId === target.storeId &&
          item.normalizedMatchAliases.includes(alias),
      ),
    );
    if (duplicatedAlias) {
      throw new BadRequestException({
        success: false,
        message: "중복된 알리아스가 있습니다.",
        errors: [{ field: "matchAliases", reason: "SALES_UNIT_DUPLICATE_MATCH_ALIAS" }],
      });
    }
  }
}

import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { CampaignSalesUnitMapping, DatabaseShape, normalizeText } from "@patima/shared";
import { AuditLogService } from "./audit-log.service";
import {
  normalizeCampaignPattern,
  recalculateAdCampaignSignaturesForStore,
} from "./ad-mapping-engine";
import { DatabaseService } from "./database.service";
import {
  createId,
  ensureNoCrossStoreReference,
  formatApiSuccess,
  nowIso,
  paginate,
} from "./helpers";
import { OperationService } from "./operation.service";
import { ProfitSummaryService } from "./profit-summary.service";
import { SalesUnitService } from "./sales-unit.service";
import { StoreService } from "./store.service";

@Injectable()
export class CampaignMappingService implements OnModuleInit {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storeService: StoreService,
    private readonly operationService: OperationService,
    private readonly auditLogService: AuditLogService,
    private readonly salesUnitService: SalesUnitService,
    private readonly profitSummaryService?: ProfitSummaryService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.operationService.registerRetryExecutor("RECALCULATE_AD_MAPPING", async (operation) =>
      this.recalculate(operation.storeId),
    );

    const storeIds = Array.from(new Set(this.databaseService.getSnapshot().stores.map((store) => store.id)));
    for (const storeId of storeIds) {
      // 먼저 스토어 레벨 판매단위 확인/생성 (write 외부에서 호출)
      await this.salesUnitService.ensureStoreLevelSalesUnit(storeId);

      await this.databaseService.writeCommitted((draft) => {
        this.seedDefaultCampaignMappingsForStore(draft, storeId);
        recalculateAdCampaignSignaturesForStore(draft, storeId, { onlyUnconfirmed: true });
      });
    }
  }

  /**
   * 스토어당 첫 설정 시 기본 캠페인 매핑 패턴을 시드 데이터로 등록
   * 이미 존재하는 패턴은 스킵하여 중복 방지 (idempotent)
   * 스토어별로 필요한 매핑 룰을 DB에 저장하여 사용자가 수정/삭제 가능
   */
  private seedDefaultCampaignMappingsForStore(draft: DatabaseShape, storeId: string): void {
    const snapshot = this.databaseService.getSnapshot();
    const store = snapshot.stores.find((s) => s.id === storeId);
    if (!store) return;

    // 기본 패턴 정의: 계획서의 매핑 룰 기반
    const defaultPatterns = [
      { keyword: "한줄무릎보호대", displayNamePattern: "한줄 무릎보호대" },
      { keyword: "두줄무릎보호대", displayNamePattern: "두줄 무릎보호대" },
      { keyword: "인피니티가드_두줄", displayNamePattern: "두줄 무릎보호대" },
      { keyword: "런닝양말", displayNamePattern: "러닝양말" },
      { keyword: "다이어트양말", displayNamePattern: "다이어트양말" },
      { keyword: "인피니티가드_다이어트양말", displayNamePattern: "다이어트양말" },
      { keyword: "유쉴드", displayNamePattern: "자외선차단 마스크" },
      { keyword: "유쉴드마스크", displayNamePattern: "자외선차단 마스크" },
      { keyword: "카프슬리브", displayNamePattern: "쿨토시" },
      { keyword: "카탈로그", displayNamePattern: "STORE_LEVEL" },
      { keyword: "키워드타겟", displayNamePattern: "STORE_LEVEL" },
      { keyword: "무릎보호대 이외", displayNamePattern: "STORE_LEVEL" },
    ];

    for (const pattern of defaultPatterns) {
      const normalized = normalizeCampaignPattern(pattern.keyword);
      if (!normalized) continue;

      // 같은 정규화 패턴이 이미 존재하는지 확인 (idempotency)
      const existing = snapshot.campaignMappings.find(
        (item) =>
          item.storeId === storeId &&
          item.normalizedCampaignPattern === normalized &&
          item.isActive,
      );
      if (existing) {
        continue; // 이미 있으면 스킵
      }

      // 대상 판매단위 찾기 (그룹 우선, 없으면 단일 유닛)
      let targetSalesUnitId: string | null = null;

      if (pattern.displayNamePattern === "STORE_LEVEL") {
        // 스토어 레벨 판매단위 찾기 (ensureStoreLevelSalesUnit 호출로 이미 존재함)
        const storeLevelUnit = snapshot.canonicalSalesUnits.find(
          (u) => u.storeId === storeId && u.isStoreLevel === true,
        );
        targetSalesUnitId = storeLevelUnit?.id ?? null;
      } else {
        // 그룹 판매단위를 우선으로 찾기
        const groupUnit = snapshot.canonicalSalesUnits.find(
          (u) =>
            u.storeId === storeId &&
            u.isActive &&
            u.isGroup &&
            normalizeText(u.displayName) === normalizeText(pattern.displayNamePattern),
        );
        if (groupUnit) {
          targetSalesUnitId = groupUnit.id;
        } else {
          // 그룹이 없으면 단일 유닛 찾기
          const targetUnit = snapshot.canonicalSalesUnits.find(
            (u) =>
              u.storeId === storeId &&
              u.isActive &&
              !u.isGroup &&
              normalizeText(u.displayName) === normalizeText(pattern.displayNamePattern),
          );
          targetSalesUnitId = targetUnit?.id ?? null;
        }
      }

      // 대상 판매단위가 없으면 스킵 (아직 생성되지 않은 판매단위)
      if (!targetSalesUnitId) {
        continue;
      }

      // 새 매핑 패턴 등록
      draft.campaignMappings.push({
        id: createId(),
        storeId,
        channel: "NAVER_DA",
        canonicalSalesUnitId: targetSalesUnitId,
        campaignPattern: pattern.keyword,
        normalizedCampaignPattern: normalized,
        isActive: true,
        deactivatedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
  }

  list(storeId: string, page?: number, pageSize?: number) {
    const items = this.databaseService
      .getSnapshot()
      .campaignMappings.filter((item) => item.storeId === storeId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return formatApiSuccess(paginate(items, page, pageSize));
  }

  async create(payload: { storeId: string; canonicalSalesUnitId: string; campaignPattern: string }) {
    this.storeService.ensureWritable(payload.storeId);
    const snapshot = this.databaseService.getSnapshot();
    let salesUnit = snapshot.canonicalSalesUnits.find((item) => item.id === payload.canonicalSalesUnitId);
    if (!salesUnit) {
      throw new NotFoundException({
        success: false,
        message: "표준 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    ensureNoCrossStoreReference(payload.storeId, salesUnit.storeId, "canonicalSalesUnitId");

    // 자식 ID를 광고 매핑에 저장하려고 하면 차단 또는 자동으로 부모로 승격
    let targetSalesUnitId = payload.canonicalSalesUnitId;
    if (salesUnit.parentSalesUnitId) {
      throw new BadRequestException({
        success: false,
        message: "그룹 자식 판매단위에는 광고를 직접 매핑할 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CANNOT_MAP_TO_GROUP_CHILD" }],
      });
    }
    const normalized = normalizeCampaignPattern(payload.campaignPattern);
    if (!normalized) {
      throw new BadRequestException({
        success: false,
        message: "빈 패턴은 저장할 수 없습니다.",
        errors: [{ field: "campaignPattern", reason: "INVALID_VALUE" }],
      });
    }
    if (normalized.length < 2) {
      throw new BadRequestException({
        success: false,
        message: "패턴 길이는 2자 이상이어야 합니다.",
        errors: [{ field: "campaignPattern", reason: "INVALID_VALUE" }],
      });
    }

    const existing = snapshot.campaignMappings.find(
      (item) => item.storeId === payload.storeId && item.normalizedCampaignPattern === normalized,
    );
    if (existing && existing.isActive) {
      throw new BadRequestException({
        success: false,
        message: "동일한 정규화 패턴이 이미 존재합니다.",
        errors: [{ field: "campaignPattern", reason: "INVALID_VALUE" }],
      });
    }

    let mapping: CampaignSalesUnitMapping;
    await this.databaseService.writeCommitted((draft) => {
      const inactive = draft.campaignMappings.find(
        (item) => item.storeId === payload.storeId && item.normalizedCampaignPattern === normalized,
      );
      if (inactive) {
        inactive.isActive = true;
        inactive.deactivatedAt = null;
        inactive.canonicalSalesUnitId = targetSalesUnitId;
        inactive.campaignPattern = payload.campaignPattern;
        inactive.updatedAt = nowIso();
        mapping = { ...inactive };
      } else {
        mapping = {
          id: createId(),
          storeId: payload.storeId,
          channel: "NAVER_DA",
          canonicalSalesUnitId: targetSalesUnitId,
          campaignPattern: payload.campaignPattern,
          normalizedCampaignPattern: normalized,
          isActive: true,
          deactivatedAt: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        draft.campaignMappings.push(mapping);
      }
    });

    const operation = await this.operationService.enqueue(
      payload.storeId,
      "RECALCULATE_AD_MAPPING",
      { storeId: payload.storeId, reason: "AD_MAPPING_CHANGED" },
      () => this.recalculate(payload.storeId),
    );

    return formatApiSuccess({
      ...mapping!,
      operationId: operation.id,
    });
  }

  async update(mappingId: string, payload: { canonicalSalesUnitId: string; campaignPattern: string }) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.campaignMappings.find((item) => item.id === mappingId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "광고 매핑 규칙을 찾을 수 없습니다.",
        errors: [{ field: "mappingId", reason: "MAPPING_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);

    // 자식 ID에 대한 검증
    const salesUnit = snapshot.canonicalSalesUnits.find((item) => item.id === payload.canonicalSalesUnitId);
    if (!salesUnit) {
      throw new NotFoundException({
        success: false,
        message: "표준 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    ensureNoCrossStoreReference(existing.storeId, salesUnit.storeId, "canonicalSalesUnitId");

    if (salesUnit.parentSalesUnitId) {
      throw new BadRequestException({
        success: false,
        message: "그룹 자식 판매단위에는 광고를 직접 매핑할 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CANNOT_MAP_TO_GROUP_CHILD" }],
      });
    }

    await this.databaseService.writeCommitted((draft) => {
      const target = draft.campaignMappings.find((item) => item.id === mappingId)!;
      target.campaignPattern = payload.campaignPattern;
      target.normalizedCampaignPattern = normalizeCampaignPattern(payload.campaignPattern);
      target.canonicalSalesUnitId = payload.canonicalSalesUnitId;
      target.updatedAt = nowIso();
    });

    const operation = await this.operationService.enqueue(
      existing.storeId,
      "RECALCULATE_AD_MAPPING",
      { storeId: existing.storeId, reason: "AD_MAPPING_CHANGED" },
      () => this.recalculate(existing.storeId),
    );

    return formatApiSuccess({
      mappingId,
      operationId: operation.id,
    });
  }

  async deactivate(mappingId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.campaignMappings.find((item) => item.id === mappingId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "광고 매핑 규칙을 찾을 수 없습니다.",
        errors: [{ field: "mappingId", reason: "MAPPING_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);

    await this.databaseService.writeCommitted((draft) => {
      const target = draft.campaignMappings.find((item) => item.id === mappingId)!;
      target.isActive = false;
      target.deactivatedAt = nowIso();
      target.updatedAt = nowIso();
    });

    const operation = await this.operationService.enqueue(
      existing.storeId,
      "RECALCULATE_AD_MAPPING",
      { storeId: existing.storeId, reason: "AD_MAPPING_CHANGED" },
      () => this.recalculate(existing.storeId),
    );

    return formatApiSuccess({
      mappingId,
      isActive: false,
      deactivatedAt: nowIso(),
      operationId: operation.id,
    });
  }

  async activate(mappingId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.campaignMappings.find((item) => item.id === mappingId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "광고 매핑 규칙을 찾을 수 없습니다.",
        errors: [{ field: "mappingId", reason: "MAPPING_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);

    await this.databaseService.writeCommitted((draft) => {
      const target = draft.campaignMappings.find((item) => item.id === mappingId)!;
      target.isActive = true;
      target.deactivatedAt = null;
      target.updatedAt = nowIso();
    });

    const operation = await this.operationService.enqueue(
      existing.storeId,
      "RECALCULATE_AD_MAPPING",
      { storeId: existing.storeId, reason: "AD_MAPPING_CHANGED" },
      () => this.recalculate(existing.storeId),
    );

    return formatApiSuccess({
      mappingId,
      isActive: true,
      reactivatedAt: nowIso(),
      operationId: operation.id,
    });
  }

  async recalculate(storeId: string) {
    await this.databaseService.writeCommitted((draft) => {
      recalculateAdCampaignSignaturesForStore(draft, storeId, {
        onlyUnconfirmed: true,
        applyToRows: true,
      });
    });
    await this.recalculateProfitSummariesForAdDates(storeId);

    return {
      recalculatedAdRows: this.databaseService
        .getSnapshot()
        .adCampaignDailyCosts.filter((item) => item.storeId === storeId).length,
      recalculatedAdSignatures: this.databaseService
        .getSnapshot()
        .adCampaignSignatures.filter((item) => item.storeId === storeId && !item.confirmedAt).length,
    };
  }

  private async recalculateProfitSummariesForAdDates(storeId: string) {
    const dates = this.databaseService
      .getSnapshot()
      .adCampaignDailyCosts.filter((item) => item.storeId === storeId)
      .map((item) => item.reportDate);

    await this.profitSummaryService?.refreshStoreDateListBestEffort({
      storeId,
      dates,
      reason: "MAPPING_CHANGE",
    });
  }
}

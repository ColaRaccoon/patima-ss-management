import { BadRequestException, Injectable, NotFoundException, OnApplicationBootstrap, OnModuleInit } from "@nestjs/common";
import { CampaignSalesUnitMapping } from "@patima/shared";
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
export class CampaignMappingService implements OnModuleInit, OnApplicationBootstrap {
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
  }

  // Nest runs provider onModuleInit hooks concurrently. The database snapshot
  // is only guaranteed to be loaded once all module initialization has finished.
  async onApplicationBootstrap(): Promise<void> {
    const startedAt = Date.now();
    const storeIds = Array.from(new Set(this.databaseService.getSnapshot().stores.map((store) => store.id)));
    if (storeIds.length === 0) return;
    for (const storeId of storeIds) {
      // 먼저 스토어 레벨 판매단위 확인/생성 (write 외부에서 호출)
      await this.salesUnitService.ensureStoreLevelSalesUnit(storeId);
    }
    // Restore all stores in one ad-only commit rather than resending the same
    // history separately for every store. Profit summaries still follow commit.
    await this.recalculateMappings(storeIds);
    for (const storeId of storeIds) await this.recalculateProfitSummariesForAdDates(storeId);
    console.log(`[Startup] Ad mapping and profit summaries restored for ${storeIds.length} stores (${Date.now() - startedAt} ms)`);
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
    await this.recalculateMappings([storeId]);
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

  private async recalculateMappings(storeIds: readonly string[]) {
    await this.databaseService.writeCommitted((draft) => {
      for (const storeId of storeIds) {
        recalculateAdCampaignSignaturesForStore(draft, storeId, {
          onlyUnconfirmed: true,
          applyToRows: true,
        });
      }
    }, ["adCampaignSignatures", "adCampaignDailyCosts"]);
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

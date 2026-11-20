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
    const changedStoreIds: string[] = [];
    for (const storeId of storeIds) {
      // 먼저 스토어 레벨 판매단위 확인/생성 (write 외부에서 호출)
      await this.salesUnitService.ensureStoreLevelSalesUnit(storeId);

      const snapshot = this.databaseService.getSnapshot();
      const signatures = snapshot.adCampaignSignatures.filter((row) => row.storeId === storeId);
      const rows = snapshot.adCampaignDailyCosts.filter((row) => row.storeId === storeId);
      const probe = {
        ...snapshot,
        adCampaignSignatures: signatures.map((row) => ({ ...row })),
        adCampaignDailyCosts: rows.map((row) => ({ ...row })),
      };
      recalculateAdCampaignSignaturesForStore(probe, storeId, { onlyUnconfirmed: true, applyToRows: true });
      const mappingState = (value: unknown) => JSON.stringify(value, (key, item) =>
        key === "updatedAt" || key === "lastAutoMappedAt" ? undefined : item,
      );
      if (
        mappingState(signatures) === mappingState(probe.adCampaignSignatures) &&
        mappingState(rows) === mappingState(probe.adCampaignDailyCosts)
      ) continue;

      changedStoreIds.push(storeId);
    }
    // Skip unchanged stores and restore changed stores in one ad-only commit.
    // Profit summaries follow the successful commit.
    if (changedStoreIds.length === 0) return;
    await this.recalculateMappings(changedStoreIds);
    for (const storeId of changedStoreIds) await this.recalculateProfitSummariesForAdDates(storeId);
    console.log(`[Startup] Ad mapping and profit summaries restored for ${changedStoreIds.length} stores (${Date.now() - startedAt} ms)`);
  }

  list(storeId: string, page?: number, pageSize?: number) {
    const items = this.databaseService
      .getSnapshot()
      .campaignMappings.filter((item) => item.storeId === storeId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return formatApiSuccess(paginate(items, page, pageSize));
  }

  async create(payload: { storeId: string; canonicalSalesUnitId: string; campaignPattern: string }) {
    const result = await this.createBatch({ storeId: payload.storeId, rules: [payload] });
    return formatApiSuccess({ ...result.data.mappings[0], operationId: result.data.operationId });
  }

  async createBatch(payload: {
    storeId: string;
    rules: Array<{ canonicalSalesUnitId: string; campaignPattern: string }>;
  }) {
    this.storeService.ensureWritable(payload.storeId);
    if (!Array.isArray(payload.rules) || payload.rules.length === 0 || payload.rules.length > 100) {
      throw new BadRequestException({
        success: false,
        message: "광고 규칙은 한 번에 1~100개까지 저장할 수 있습니다.",
        errors: [{ field: "rules", reason: "INVALID_VALUE" }],
      });
    }
    const validate = (snapshot: ReturnType<DatabaseService["getSnapshot"]>) => {
      const seen = new Set<string>();
      return payload.rules.map((rule) => this.validateNewRule(
        snapshot, { ...rule, storeId: payload.storeId }, seen,
      ));
    };
    validate(this.databaseService.getSnapshot());
    const mappings = await this.databaseService.writeCommitted((draft) => {
      // Recheck the queued snapshot before mutating anything: concurrent requests
      // must not reactivate or overwrite a rule that has just become active.
      const rules = validate(draft);
      return rules.map((rule) => {
        const inactive = draft.campaignMappings.find(
          (item) => item.storeId === payload.storeId && item.normalizedCampaignPattern === rule.normalized,
        );
        if (inactive) {
          inactive.isActive = true;
          inactive.deactivatedAt = null;
          inactive.canonicalSalesUnitId = rule.canonicalSalesUnitId;
          inactive.campaignPattern = rule.campaignPattern;
          inactive.updatedAt = nowIso();
          return { ...inactive };
        }
        const mapping: CampaignSalesUnitMapping = {
          id: createId(),
          storeId: payload.storeId,
          channel: "NAVER_DA",
          canonicalSalesUnitId: rule.canonicalSalesUnitId,
          campaignPattern: rule.campaignPattern,
          normalizedCampaignPattern: rule.normalized,
          isActive: true,
          deactivatedAt: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        draft.campaignMappings.push(mapping);
        return { ...mapping };
      });
    }, ["campaignMappings"]);
    const operation = await this.operationService.enqueue(
      payload.storeId,
      "RECALCULATE_AD_MAPPING",
      { storeId: payload.storeId, reason: "AD_MAPPING_CHANGED" },
      () => this.recalculate(payload.storeId),
    );
    return formatApiSuccess({ mappings, operationId: operation.id });
  }

  private validateNewRule(
    snapshot: ReturnType<DatabaseService["getSnapshot"]>,
    payload: { storeId: string; canonicalSalesUnitId: string; campaignPattern: string },
    seen: Set<string>,
  ) {
    const salesUnit = snapshot.canonicalSalesUnits.find((item) => item.id === payload.canonicalSalesUnitId);
    if (!salesUnit) {
      throw new NotFoundException({
        success: false,
        message: "표준 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    ensureNoCrossStoreReference(payload.storeId, salesUnit.storeId, "canonicalSalesUnitId");

    if (salesUnit.parentSalesUnitId) {
      throw new BadRequestException({
        success: false,
        message: "그룹 자식 판매단위에는 광고를 직접 매핑할 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CANNOT_MAP_TO_GROUP_CHILD" }],
      });
    }
    const normalized = typeof payload.campaignPattern === "string"
      ? normalizeCampaignPattern(payload.campaignPattern)
      : "";
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
    if ((existing && existing.isActive) || seen.has(normalized)) {
      throw new BadRequestException({
        success: false,
        message: "동일한 정규화 패턴이 이미 존재합니다.",
        errors: [{ field: "campaignPattern", reason: "INVALID_VALUE" }],
      });
    }

    seen.add(normalized);
    return { ...payload, normalized };
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

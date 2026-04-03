import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { CampaignSalesUnitMapping } from "@patima/shared";
import { AuditLogService } from "./audit-log.service";
import {
  evaluateAdMapping,
  getActiveCampaignMappings,
  normalizeCampaignPattern,
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
import { StoreService } from "./store.service";

@Injectable()
export class CampaignMappingService implements OnModuleInit {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storeService: StoreService,
    private readonly operationService: OperationService,
    private readonly auditLogService: AuditLogService,
  ) {}

  onModuleInit(): void {
    this.operationService.registerRetryExecutor("RECALCULATE_AD_MAPPING", async (operation) =>
      this.recalculate(operation.storeId),
    );
  }

  list(storeId: string, page?: number, pageSize?: number) {
    const items = this.databaseService
      .getSnapshot()
      .campaignMappings.filter((item) => item.storeId === storeId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return formatApiSuccess(paginate(items, page, pageSize));
  }

  create(payload: { storeId: string; canonicalSalesUnitId: string; campaignPattern: string }) {
    this.storeService.ensureWritable(payload.storeId);
    const snapshot = this.databaseService.getSnapshot();
    const salesUnit = snapshot.canonicalSalesUnits.find((item) => item.id === payload.canonicalSalesUnitId);
    if (!salesUnit) {
      throw new NotFoundException({
        success: false,
        message: "표준 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    ensureNoCrossStoreReference(payload.storeId, salesUnit.storeId, "canonicalSalesUnitId");
    const normalized = normalizeCampaignPattern(payload.campaignPattern);
    if (!normalized) {
      throw new BadRequestException({
        success: false,
        message: "빈 패턴은 저장할 수 없습니다.",
        errors: [{ field: "campaignPattern", reason: "INVALID_VALUE" }],
      });
    }
    if (normalized.length < 3) {
      throw new BadRequestException({
        success: false,
        message: "패턴 길이는 3자 이상이어야 합니다.",
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
    this.databaseService.write((draft) => {
      const inactive = draft.campaignMappings.find(
        (item) => item.storeId === payload.storeId && item.normalizedCampaignPattern === normalized,
      );
      if (inactive) {
        inactive.isActive = true;
        inactive.deactivatedAt = null;
        inactive.canonicalSalesUnitId = payload.canonicalSalesUnitId;
        inactive.campaignPattern = payload.campaignPattern;
        inactive.updatedAt = nowIso();
        mapping = { ...inactive };
      } else {
        mapping = {
          id: createId(),
          storeId: payload.storeId,
          channel: "NAVER_DA",
          canonicalSalesUnitId: payload.canonicalSalesUnitId,
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

    const operation = this.operationService.enqueue(
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

  update(mappingId: string, payload: { canonicalSalesUnitId: string; campaignPattern: string }) {
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

    this.databaseService.write((draft) => {
      const target = draft.campaignMappings.find((item) => item.id === mappingId)!;
      target.campaignPattern = payload.campaignPattern;
      target.normalizedCampaignPattern = normalizeCampaignPattern(payload.campaignPattern);
      target.canonicalSalesUnitId = payload.canonicalSalesUnitId;
      target.updatedAt = nowIso();
    });

    const operation = this.operationService.enqueue(
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

  deactivate(mappingId: string) {
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

    this.databaseService.write((draft) => {
      const target = draft.campaignMappings.find((item) => item.id === mappingId)!;
      target.isActive = false;
      target.deactivatedAt = nowIso();
      target.updatedAt = nowIso();
    });

    return formatApiSuccess({
      mappingId,
      isActive: false,
      deactivatedAt: nowIso(),
    });
  }

  activate(mappingId: string) {
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

    this.databaseService.write((draft) => {
      const target = draft.campaignMappings.find((item) => item.id === mappingId)!;
      target.isActive = true;
      target.deactivatedAt = null;
      target.updatedAt = nowIso();
    });

    return formatApiSuccess({
      mappingId,
      isActive: true,
      reactivatedAt: nowIso(),
    });
  }

  async recalculate(storeId: string) {
    this.databaseService.write((draft) => {
      draft.adCampaignDailyCosts
        .filter((item) => item.storeId === storeId)
        .forEach((item) => {
          if (item.mappingReason === "INTENTIONALLY_UNMAPPED" && item.reasonNote) {
            return;
          }
          const mapping = evaluateAdMapping(draft, storeId, item.normalizedCampaignName);
          item.canonicalSalesUnitId = mapping.canonicalSalesUnitId;
          item.matchedRuleCount = mapping.matchedRuleCount;
          item.mappingReason = mapping.mappingReason;
          item.reasonNote = mapping.reasonNote;
          item.updatedAt = nowIso();
        });
    });

    return {
      recalculatedAdRows: this.databaseService
        .getSnapshot()
        .adCampaignDailyCosts.filter((item) => item.storeId === storeId).length,
    };
  }
}

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { SalesUnitCostSetting } from "@patima/shared";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import {
  createId,
  ensureNoCrossStoreReference,
  formatApiSuccess,
  nowIso,
} from "./helpers";
import { StoreService } from "./store.service";

@Injectable()
export class CostService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storeService: StoreService,
    private readonly auditLogService: AuditLogService,
  ) {}

  list(storeId: string, canonicalSalesUnitId?: string) {
    const snapshot = this.databaseService.getSnapshot();
    const items = snapshot.salesUnitCostSettings
      .filter((item) => item.storeId === storeId)
      .filter((item) => (canonicalSalesUnitId ? item.canonicalSalesUnitId === canonicalSalesUnitId : true))
      .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))
      .map((item) => {
        const appliedOrderItemCount = snapshot.orderItems.filter(
          (orderItem) =>
            orderItem.storeId === storeId &&
            orderItem.canonicalSalesUnitId === item.canonicalSalesUnitId &&
            !!orderItem.paymentDate &&
            orderItem.paymentDate >= item.effectiveFrom &&
            (!item.effectiveTo || orderItem.paymentDate <= item.effectiveTo),
        ).length;

        return {
          ...item,
          appliedOrderItemCount,
          canEdit: appliedOrderItemCount === 0 && item.isActive,
          canClose: item.isActive,
          canDeactivate: appliedOrderItemCount === 0 && item.isActive,
          blockingReason: appliedOrderItemCount > 0 ? "ALREADY_APPLIED" : item.isActive ? null : "ALREADY_INACTIVE",
        };
      });

    return formatApiSuccess(items);
  }

  create(payload: {
    storeId: string;
    canonicalSalesUnitId: string;
    unitCost: number;
    feeRate: number | null;
    otherCost: number;
    effectiveFrom: string;
  }) {
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
    this.validateValues(payload.unitCost, payload.otherCost, payload.feeRate);

    const activeRows = snapshot.salesUnitCostSettings
      .filter(
        (item) =>
          item.storeId === payload.storeId &&
          item.canonicalSalesUnitId === payload.canonicalSalesUnitId &&
          item.isActive,
      )
      .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));

    const sameStart = activeRows.find((item) => item.effectiveFrom === payload.effectiveFrom);
    if (sameStart) {
      throw new BadRequestException({
        success: false,
        message: "같은 시작일 비용 row가 이미 존재합니다.",
        errors: [{ field: "effectiveFrom", reason: "COST_PERIOD_OVERLAP" }],
      });
    }

    const previousRow = activeRows
      .filter((item) => item.effectiveFrom < payload.effectiveFrom)
      .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0];
    const nextRow = activeRows
      .filter((item) => item.effectiveFrom > payload.effectiveFrom)
      .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom))[0];

    if (nextRow && payload.effectiveFrom >= nextRow.effectiveFrom) {
      throw new BadRequestException({
        success: false,
        message: "다음 비용 구간과 충돌합니다.",
        errors: [{ field: "effectiveFrom", reason: "COST_PERIOD_OVERLAP" }],
      });
    }

    if (previousRow?.effectiveTo && payload.effectiveFrom <= previousRow.effectiveTo) {
      throw new BadRequestException({
        success: false,
        message: "기존 비용 기간 한가운데 삽입할 수 없습니다.",
        errors: [{ field: "effectiveFrom", reason: "COST_PERIOD_SPLIT_NOT_SUPPORTED" }],
      });
    }

    const created: SalesUnitCostSetting = {
      id: createId(),
      storeId: payload.storeId,
      canonicalSalesUnitId: payload.canonicalSalesUnitId,
      unitCost: payload.unitCost,
      feeRate: payload.feeRate,
      otherCost: payload.otherCost,
      isActive: true,
      deactivatedAt: null,
      effectiveFrom: payload.effectiveFrom,
      effectiveTo: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    this.databaseService.write((draft) => {
      const previous = draft.salesUnitCostSettings.find((item) => item.id === previousRow?.id);
      if (previous && !previous.effectiveTo) {
        previous.effectiveTo = this.minusOneDay(payload.effectiveFrom);
        previous.updatedAt = nowIso();
      }
      draft.salesUnitCostSettings.push(created);
    });

    return formatApiSuccess({
      costSettingId: created.id,
      canonicalSalesUnitId: created.canonicalSalesUnitId,
      effectiveFrom: created.effectiveFrom,
      effectiveTo: created.effectiveTo,
      isActive: created.isActive,
    });
  }

  update(costSettingId: string, payload: { unitCost: number; feeRate: number | null; otherCost: number; effectiveFrom: string }) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.salesUnitCostSettings.find((item) => item.id === costSettingId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "비용 설정 row를 찾을 수 없습니다.",
        errors: [{ field: "costSettingId", reason: "COST_SETTING_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);
    const appliedCount = snapshot.orderItems.filter(
      (orderItem) =>
        orderItem.storeId === existing.storeId &&
        orderItem.canonicalSalesUnitId === existing.canonicalSalesUnitId &&
        !!orderItem.paymentDate &&
        orderItem.paymentDate >= existing.effectiveFrom &&
        (!existing.effectiveTo || orderItem.paymentDate <= existing.effectiveTo),
    ).length;
    if (appliedCount > 0) {
      throw new BadRequestException({
        success: false,
        message: "이미 적용된 비용 row는 직접 수정할 수 없습니다.",
        errors: [{ field: "costSettingId", reason: "COST_SETTING_NOT_EDITABLE" }],
      });
    }
    this.validateValues(payload.unitCost, payload.otherCost, payload.feeRate);

    this.databaseService.write((draft) => {
      const target = draft.salesUnitCostSettings.find((item) => item.id === costSettingId)!;
      target.unitCost = payload.unitCost;
      target.feeRate = payload.feeRate;
      target.otherCost = payload.otherCost;
      target.effectiveFrom = payload.effectiveFrom;
      target.updatedAt = nowIso();
    });

    return formatApiSuccess({
      costSettingId,
      effectiveFrom: payload.effectiveFrom,
      effectiveTo: existing.effectiveTo,
      isActive: existing.isActive,
    });
  }

  close(costSettingId: string, payload: { effectiveTo: string }) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.salesUnitCostSettings.find((item) => item.id === costSettingId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "비용 설정 row를 찾을 수 없습니다.",
        errors: [{ field: "costSettingId", reason: "COST_SETTING_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);
    if (payload.effectiveTo < existing.effectiveFrom) {
      throw new BadRequestException({
        success: false,
        message: "종료일은 시작일보다 빠를 수 없습니다.",
        errors: [{ field: "effectiveTo", reason: "INVALID_DATE_RANGE" }],
      });
    }

    this.databaseService.write((draft) => {
      const target = draft.salesUnitCostSettings.find((item) => item.id === costSettingId)!;
      target.effectiveTo = payload.effectiveTo;
      target.updatedAt = nowIso();
    });

    return formatApiSuccess({
      costSettingId,
      effectiveTo: payload.effectiveTo,
      isClosed: true,
    });
  }

  deactivate(costSettingId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.salesUnitCostSettings.find((item) => item.id === costSettingId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "비용 설정 row를 찾을 수 없습니다.",
        errors: [{ field: "costSettingId", reason: "COST_SETTING_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);
    const appliedCount = snapshot.orderItems.filter(
      (orderItem) =>
        orderItem.storeId === existing.storeId &&
        orderItem.canonicalSalesUnitId === existing.canonicalSalesUnitId &&
        !!orderItem.paymentDate &&
        orderItem.paymentDate >= existing.effectiveFrom &&
        (!existing.effectiveTo || orderItem.paymentDate <= existing.effectiveTo),
    ).length;
    if (appliedCount > 0) {
      throw new BadRequestException({
        success: false,
        message: "이미 적용된 이력 row는 비활성화할 수 없습니다.",
        errors: [{ field: "costSettingId", reason: "COST_SETTING_ALREADY_APPLIED" }],
      });
    }

    this.databaseService.write((draft) => {
      const target = draft.salesUnitCostSettings.find((item) => item.id === costSettingId)!;
      target.isActive = false;
      target.deactivatedAt = nowIso();
      target.updatedAt = nowIso();
    });

    return formatApiSuccess({
      costSettingId,
      isActive: false,
      deactivatedAt: nowIso(),
    });
  }

  private validateValues(unitCost: number, otherCost: number, feeRate: number | null) {
    if (unitCost < 0 || otherCost < 0) {
      throw new BadRequestException({
        success: false,
        message: "원가와 기타비용은 0 이상이어야 합니다.",
        errors: [{ field: "unitCost", reason: "INVALID_VALUE" }],
      });
    }
    if (feeRate != null && (feeRate < 0 || feeRate > 1)) {
      throw new BadRequestException({
        success: false,
        message: "feeRate는 0 이상 1 이하여야 합니다.",
        errors: [{ field: "feeRate", reason: "INVALID_VALUE" }],
      });
    }
  }

  private minusOneDay(dateString: string) {
    const date = new Date(`${dateString}T00:00:00+09:00`);
    date.setDate(date.getDate() - 1);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }
}

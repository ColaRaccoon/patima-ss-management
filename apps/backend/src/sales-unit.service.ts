import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { CanonicalSalesUnit, normalizeText } from "@patima/shared";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import {
  createDisplayName,
  createId,
  ensureNoCrossStoreReference,
  ensureStoreExists,
  formatApiSuccess,
  normalizedDisplayName,
  nowIso,
  paginate,
} from "./helpers";
import { StoreService } from "./store.service";

interface SalesUnitPayload {
  storeId: string;
  standardProductName: string;
  standardOptionName?: string | null;
  displayName?: string | null;
  memo?: string | null;
}

@Injectable()
export class SalesUnitService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storeService: StoreService,
    private readonly auditLogService: AuditLogService,
  ) {}

  list(storeId: string, q?: string, page?: number, pageSize?: number) {
    const keyword = q ? normalizeText(q) : null;
    const items = this.databaseService
      .getSnapshot()
      .canonicalSalesUnits.filter((item) => item.storeId === storeId)
      .filter((item) => (keyword ? item.normalizedDisplayName.includes(keyword) : true))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    return formatApiSuccess(paginate(items, page, pageSize));
  }

  create(payload: SalesUnitPayload) {
    this.storeService.ensureWritable(payload.storeId);
    const standardOptionName = payload.standardOptionName ?? null;
    const displayName = payload.displayName?.trim() || createDisplayName(payload.standardProductName, standardOptionName);
    const created: CanonicalSalesUnit = {
      id: createId(),
      storeId: payload.storeId,
      standardProductName: payload.standardProductName,
      standardOptionName,
      normalizedStandardProductName: normalizeText(payload.standardProductName),
      normalizedStandardOptionName: normalizeText(standardOptionName),
      displayName,
      normalizedDisplayName: normalizeText(displayName),
      memo: payload.memo ?? null,
      isActive: true,
      deactivatedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    this.ensureUnique(created);

    this.databaseService.write((draft) => {
      ensureStoreExists(draft, payload.storeId);
      draft.canonicalSalesUnits.push(created);
    });

    this.auditLogService.record({
      storeId: payload.storeId,
      domain: "SALES_UNIT",
      action: "CREATE",
      targetId: created.id,
      actorIdentifier: "LOCALHOST_ADMIN",
      beforeJson: null,
      afterJson: created,
    });

    return formatApiSuccess(created);
  }

  update(salesUnitId: string, payload: Omit<SalesUnitPayload, "storeId">) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.canonicalSalesUnits.find((item) => item.id === salesUnitId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "표준 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "salesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);

    const updated: CanonicalSalesUnit = {
      ...existing,
      standardProductName: payload.standardProductName,
      standardOptionName: payload.standardOptionName ?? null,
      normalizedStandardProductName: normalizeText(payload.standardProductName),
      normalizedStandardOptionName: normalizeText(payload.standardOptionName),
      displayName:
        payload.displayName?.trim() ||
        createDisplayName(payload.standardProductName, payload.standardOptionName ?? null),
      normalizedDisplayName: normalizedDisplayName(
        payload.standardProductName,
        payload.standardOptionName ?? null,
      ),
      memo: payload.memo ?? null,
      updatedAt: nowIso(),
    };
    this.ensureUnique(updated, salesUnitId);

    this.databaseService.write((draft) => {
      const target = draft.canonicalSalesUnits.find((item) => item.id === salesUnitId)!;
      Object.assign(target, updated);
    });

    this.auditLogService.record({
      storeId: existing.storeId,
      domain: "SALES_UNIT",
      action: "UPDATE",
      targetId: salesUnitId,
      actorIdentifier: "LOCALHOST_ADMIN",
      beforeJson: existing,
      afterJson: updated,
    });

    return formatApiSuccess(updated);
  }

  deactivate(salesUnitId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.canonicalSalesUnits.find((item) => item.id === salesUnitId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "표준 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "salesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);

    this.databaseService.write((draft) => {
      const target = draft.canonicalSalesUnits.find((item) => item.id === salesUnitId)!;
      target.isActive = false;
      target.deactivatedAt = nowIso();
      target.updatedAt = nowIso();
    });

    return formatApiSuccess({
      salesUnitId,
      isActive: false,
      deactivatedAt: nowIso(),
    });
  }

  activate(salesUnitId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const existing = snapshot.canonicalSalesUnits.find((item) => item.id === salesUnitId);
    if (!existing) {
      throw new NotFoundException({
        success: false,
        message: "표준 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "salesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);

    this.databaseService.write((draft) => {
      const target = draft.canonicalSalesUnits.find((item) => item.id === salesUnitId)!;
      target.isActive = true;
      target.deactivatedAt = null;
      target.updatedAt = nowIso();
    });

    return formatApiSuccess({
      salesUnitId,
      isActive: true,
      reactivatedAt: nowIso(),
    });
  }

  private ensureUnique(target: CanonicalSalesUnit, excludeId?: string) {
    const snapshot = this.databaseService.getSnapshot();
    const duplicatedDisplay = snapshot.canonicalSalesUnits.some(
      (item) =>
        item.id !== excludeId &&
        item.storeId === target.storeId &&
        item.normalizedDisplayName === target.normalizedDisplayName,
    );
    if (duplicatedDisplay) {
      throw new BadRequestException({
        success: false,
        message: "정규화된 표시명이 중복됩니다.",
        errors: [{ field: "displayName", reason: "SALES_UNIT_DUPLICATE_DISPLAY_NAME" }],
      });
    }
    const duplicatedCombo = snapshot.canonicalSalesUnits.some(
      (item) =>
        item.id !== excludeId &&
        item.storeId === target.storeId &&
        item.normalizedStandardProductName === target.normalizedStandardProductName &&
        item.normalizedStandardOptionName === target.normalizedStandardOptionName,
    );
    if (duplicatedCombo) {
      throw new BadRequestException({
        success: false,
        message: "정규화된 표준 상품/옵션 조합이 중복됩니다.",
        errors: [{ field: "standardProductName", reason: "SALES_UNIT_DUPLICATE_STANDARD_COMBINATION" }],
      });
    }
  }
}

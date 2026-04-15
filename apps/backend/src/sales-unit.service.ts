import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { CanonicalSalesUnit, normalizeMatchAlias, normalizeText } from "@patima/shared";
import { recalculateAdMappingsForStore } from "./ad-mapping-engine";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import {
  createId,
  ensureNormalizedLength,
  ensureStoreExists,
  formatApiSuccess,
  normalizeMatchAliasList,
  nowIso,
  paginate,
  sanitizeMatchAliases,
} from "./helpers";
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
}

@Injectable()
export class SalesUnitService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storeService: StoreService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * 스토어 전체 광고비 판매단위를 확인하고 없으면 자동 생성
   * 스토어당 1개만 존재해야 함
   */
  ensureStoreLevelSalesUnit(storeId: string): string {
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
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    this.databaseService.write((draft) => {
      draft.canonicalSalesUnits.push(newUnit);
    });

    this.auditLogService.record({
      storeId,
      domain: "SALES_UNIT",
      action: "CREATE_STORE_LEVEL",
      targetId: newUnit.id,
      actorIdentifier: "LOCALHOST_ADMIN",
      beforeJson: null,
      afterJson: newUnit,
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

  create(payload: SalesUnitPayload, options?: SalesUnitCreateOptions) {
    this.storeService.ensureWritable(payload.storeId);
    const displayName = payload.displayName.trim();
    const matchAliases = sanitizeMatchAliases(payload.matchAliases ?? []);
    ensureNormalizedLength(normalizeText(displayName), "displayName");

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
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    this.ensureUnique(created);

    this.databaseService.write((draft) => {
      ensureStoreExists(draft, payload.storeId);
      draft.canonicalSalesUnits.push(created);
      if (!options?.skipOrderRecalculation) {
        recalculateOrderMappingsForStore(draft, payload.storeId);
      }
      if (!options?.skipAdRecalculation) {
        recalculateAdMappingsForStore(draft, payload.storeId);
      }
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
        message: "?쒖? ?먮ℓ?⑥쐞瑜?李얠쓣 ???놁뒿?덈떎.",
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

    this.databaseService.write((draft) => {
      const target = draft.canonicalSalesUnits.find((item) => item.id === salesUnitId)!;
      Object.assign(target, updated);
      recalculateOrderMappingsForStore(draft, existing.storeId);
      recalculateAdMappingsForStore(draft, existing.storeId);
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
        message: "?쒖? ?먮ℓ?⑥쐞瑜?李얠쓣 ???놁뒿?덈떎.",
        errors: [{ field: "salesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);

    this.databaseService.write((draft) => {
      const target = draft.canonicalSalesUnits.find((item) => item.id === salesUnitId)!;
      target.isActive = false;
      target.deactivatedAt = nowIso();
      target.updatedAt = nowIso();
      recalculateOrderMappingsForStore(draft, existing.storeId);
      recalculateAdMappingsForStore(draft, existing.storeId);
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
        message: "?쒖? ?먮ℓ?⑥쐞瑜?李얠쓣 ???놁뒿?덈떎.",
        errors: [{ field: "salesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(existing.storeId);

    this.databaseService.write((draft) => {
      const target = draft.canonicalSalesUnits.find((item) => item.id === salesUnitId)!;
      target.isActive = true;
      target.deactivatedAt = null;
      target.updatedAt = nowIso();
      recalculateOrderMappingsForStore(draft, existing.storeId);
      recalculateAdMappingsForStore(draft, existing.storeId);
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
        normalizeText(item.displayName) === normalizeText(target.displayName),
    );
    if (duplicatedDisplay) {
      throw new BadRequestException({
        success: false,
        message: "?뺢퇋?붾맂 ?쒖떆紐낆씠 以묐났?⑸땲??",
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
        message: "以묐났?섎뒗 alias瑜?뺣낫?룄濡???ν븷 ???놁뒿?덈떎.",
        errors: [{ field: "matchAliases", reason: "SALES_UNIT_DUPLICATE_MATCH_ALIAS" }],
      });
    }
  }
}

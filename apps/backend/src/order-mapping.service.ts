import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import {
  ensureNoCrossStoreReference,
  formatApiSuccess,
  nowIso,
} from "./helpers";
import { OperationService } from "./operation.service";
import { recalculateOrderMappingsForStore } from "./sales-unit-auto-mapper";
import { SalesUnitService } from "./sales-unit.service";
import { StoreService } from "./store.service";

@Injectable()
export class OrderMappingService implements OnModuleInit {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly operationService: OperationService,
    private readonly storeService: StoreService,
    private readonly salesUnitService: SalesUnitService,
  ) {}

  onModuleInit(): void {
    this.operationService.registerRetryExecutor("RECALCULATE_ORDER_MAPPING", async (operation) => {
      return this.recalculate(operation.storeId);
    });

    const storeIds = Array.from(new Set(this.databaseService.getSnapshot().stores.map((store) => store.id)));
    storeIds.forEach((storeId) => {
      this.databaseService.write((draft) => {
        recalculateOrderMappingsForStore(draft, storeId);
      });
    });
  }

  saveMapping(signatureId: string, payload: { canonicalSalesUnitId: string }) {
    const result = this.saveMappingsInternal([signatureId], payload);
    return formatApiSuccess({
      signatureId,
      canonicalSalesUnitId: payload.canonicalSalesUnitId,
      operationId: result.operationId,
    });
  }

  saveMappings(signatureIds: string[], payload: { canonicalSalesUnitId: string }) {
    const result = this.saveMappingsInternal(signatureIds, payload);
    return formatApiSuccess({
      signatureIds: result.signatureIds,
      canonicalSalesUnitId: payload.canonicalSalesUnitId,
      updatedCount: result.signatureIds.length,
      operationId: result.operationId,
    });
  }

  createAndMap(signatureId: string, payload: { displayName: string; matchAliases?: string[] | null; linkedProductIds?: string[] | null; linkedOptionCodes?: string[] | null; memo?: string | null }) {
    const result = this.createAndMapMany([signatureId], payload);
    return formatApiSuccess({
      signatureId,
      canonicalSalesUnitId: result.data.canonicalSalesUnitId,
      operationId: result.data.operationId,
    });
  }

  createAndMapMany(signatureIds: string[], payload: { displayName: string; matchAliases?: string[] | null; linkedProductIds?: string[] | null; linkedOptionCodes?: string[] | null; memo?: string | null }) {
    const { storeId } = this.resolveSignatureBatch(signatureIds);
    const createdResponse = this.salesUnitService.create({
      storeId,
      displayName: payload.displayName,
      matchAliases: payload.matchAliases,
      linkedProductIds: payload.linkedProductIds,
      linkedOptionCodes: payload.linkedOptionCodes,
      memo: payload.memo,
    }, { skipOrderRecalculation: true });
    const created = createdResponse.data;
    const result = this.saveMappingsInternal(signatureIds, { canonicalSalesUnitId: created.id });
    return formatApiSuccess({
      signatureIds: result.signatureIds,
      canonicalSalesUnitId: created.id,
      createdSalesUnitId: created.id,
      updatedCount: result.signatureIds.length,
      operationId: result.operationId,
    });
  }

  private saveMappingsInternal(signatureIds: string[], payload: { canonicalSalesUnitId: string }) {
    const { snapshot, storeId, dedupedIds } = this.resolveSignatureBatch(signatureIds);
    this.storeService.ensureWritable(storeId);

    const salesUnit = snapshot.canonicalSalesUnits.find((item) => item.id === payload.canonicalSalesUnitId);
    if (!salesUnit) {
      throw new NotFoundException({
        success: false,
        message: "표준 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    ensureNoCrossStoreReference(storeId, salesUnit.storeId, "canonicalSalesUnitId");
    if (!salesUnit.isActive) {
      throw new BadRequestException({
        success: false,
        message: "비활성화된 판매단위에는 매핑할 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "INVALID_VALUE" }],
      });
    }
    // 그룹 판매단위에는 주문을 직접 매핑할 수 없음 (자식 또는 단독 유닛만 가능)
    if (salesUnit.isGroup) {
      throw new BadRequestException({
        success: false,
        message: "그룹 판매단위에는 주문을 직접 매핑할 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CANNOT_MAP_TO_GROUP" }],
      });
    }

    const targetIds = new Set(dedupedIds);
    const timestamp = nowIso();
    this.databaseService.write((draft) => {
      draft.orderSourceSignatures.forEach((item) => {
        if (!targetIds.has(item.id)) {
          return;
        }
        item.canonicalSalesUnitId = payload.canonicalSalesUnitId;
        item.mappingStatus = "MAPPED";
        item.confirmedAt = timestamp;
        item.updatedAt = timestamp;
      });
    });

    const operation = this.operationService.enqueue(
      storeId,
      "RECALCULATE_ORDER_MAPPING",
      { storeId, reason: "ORDER_MAPPING_CHANGED", signatureIds: dedupedIds },
      () => this.recalculate(storeId),
    );

    return {
      signatureIds: dedupedIds,
      operationId: operation.id,
    };
  }

  private resolveSignatureBatch(signatureIds: string[]) {
    const dedupedIds = Array.from(new Set(signatureIds.filter(Boolean)));
    if (!dedupedIds.length) {
      throw new BadRequestException({
        success: false,
        message: "매핑할 주문 원본 조합을 하나 이상 선택해 주세요.",
        errors: [{ field: "signatureIds", reason: "INVALID_VALUE" }],
      });
    }

    const snapshot = this.databaseService.getSnapshot();
    const signatures = dedupedIds.map((signatureId) => {
      const signature = snapshot.orderSourceSignatures.find((item) => item.id === signatureId);
      if (!signature) {
        throw new NotFoundException({
          success: false,
          message: "주문 원본 조합을 찾을 수 없습니다.",
          errors: [{ field: "signatureIds", reason: "ORDER_SOURCE_SIGNATURE_NOT_FOUND" }],
        });
      }
      return signature;
    });

    const storeIds = Array.from(new Set(signatures.map((signature) => signature.storeId)));
    if (storeIds.length !== 1) {
      throw new BadRequestException({
        success: false,
        message: "같은 스토어의 주문 원본 조합만 함께 매핑할 수 있습니다.",
        errors: [{ field: "signatureIds", reason: "CROSS_STORE_REFERENCE" }],
      });
    }

    return {
      snapshot,
      storeId: storeIds[0],
      dedupedIds,
    };
  }

  async recalculate(storeId: string) {
    this.databaseService.write((draft) => {
      recalculateOrderMappingsForStore(draft, storeId);
    });

    return {
      recalculatedOrderItems: this.databaseService
        .getSnapshot()
        .orderItems.filter((item) => item.storeId === storeId).length,
    };
  }
}

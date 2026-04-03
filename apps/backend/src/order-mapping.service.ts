import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import {
  createId,
  ensureNoCrossStoreReference,
  ensureStoreExists,
  formatApiSuccess,
  isSalesUnitAssignable,
  nowIso,
} from "./helpers";
import { OperationService } from "./operation.service";
import { SalesUnitService } from "./sales-unit.service";
import { StoreService } from "./store.service";

@Injectable()
export class OrderMappingService implements OnModuleInit {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly operationService: OperationService,
    private readonly storeService: StoreService,
    private readonly salesUnitService: SalesUnitService,
    private readonly auditLogService: AuditLogService,
  ) {}

  onModuleInit(): void {
    this.operationService.registerRetryExecutor("RECALCULATE_ORDER_MAPPING", async (operation) => {
      return this.recalculate(operation.storeId);
    });
  }

  saveMapping(signatureId: string, payload: { canonicalSalesUnitId: string }) {
    const snapshot = this.databaseService.getSnapshot();
    const signature = snapshot.orderSourceSignatures.find((item) => item.id === signatureId);
    if (!signature) {
      throw new NotFoundException({
        success: false,
        message: "주문 원본 조합을 찾을 수 없습니다.",
        errors: [{ field: "signatureId", reason: "ORDER_SOURCE_SIGNATURE_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(signature.storeId);
    const salesUnit = snapshot.canonicalSalesUnits.find((item) => item.id === payload.canonicalSalesUnitId);
    if (!salesUnit) {
      throw new NotFoundException({
        success: false,
        message: "표준 판매단위를 찾을 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "CANONICAL_SALES_UNIT_NOT_FOUND" }],
      });
    }
    ensureNoCrossStoreReference(signature.storeId, salesUnit.storeId, "canonicalSalesUnitId");
    if (!salesUnit.isActive) {
      throw new BadRequestException({
        success: false,
        message: "비활성화된 판매단위에는 매핑할 수 없습니다.",
        errors: [{ field: "canonicalSalesUnitId", reason: "INVALID_VALUE" }],
      });
    }

    this.databaseService.write((draft) => {
      const target = draft.orderSourceSignatures.find((item) => item.id === signatureId)!;
      target.canonicalSalesUnitId = payload.canonicalSalesUnitId;
      target.confirmedAt = nowIso();
      target.updatedAt = nowIso();
    });

    const operation = this.operationService.enqueue(
      signature.storeId,
      "RECALCULATE_ORDER_MAPPING",
      { storeId: signature.storeId, reason: "ORDER_MAPPING_CHANGED" },
      () => this.recalculate(signature.storeId),
    );

    return formatApiSuccess({
      signatureId,
      canonicalSalesUnitId: payload.canonicalSalesUnitId,
      operationId: operation.id,
    });
  }

  createAndMap(signatureId: string, payload: { standardProductName: string; standardOptionName?: string | null; displayName?: string | null; memo?: string | null }) {
    const snapshot = this.databaseService.getSnapshot();
    const signature = snapshot.orderSourceSignatures.find((item) => item.id === signatureId);
    if (!signature) {
      throw new NotFoundException({
        success: false,
        message: "주문 원본 조합을 찾을 수 없습니다.",
        errors: [{ field: "signatureId", reason: "ORDER_SOURCE_SIGNATURE_NOT_FOUND" }],
      });
    }
    this.storeService.ensureWritable(signature.storeId);
    const createdResponse = this.salesUnitService.create({
      storeId: signature.storeId,
      standardProductName: payload.standardProductName,
      standardOptionName: payload.standardOptionName,
      displayName: payload.displayName,
      memo: payload.memo,
    });
    const created = createdResponse.data;
    return this.saveMapping(signatureId, { canonicalSalesUnitId: created.id });
  }

  async recalculate(storeId: string) {
    this.databaseService.write((draft) => {
      const signaturesById = new Map(draft.orderSourceSignatures.filter((item) => item.storeId === storeId).map((item) => [item.id, item]));
      const salesUnitsById = new Map(draft.canonicalSalesUnits.filter((item) => item.storeId === storeId).map((item) => [item.id, item]));
      draft.orderItems
        .filter((item) => item.storeId === storeId)
        .forEach((item) => {
          const signature = item.orderSourceSignatureId ? signaturesById.get(item.orderSourceSignatureId) : null;
          const candidate = signature?.canonicalSalesUnitId
            ? salesUnitsById.get(signature.canonicalSalesUnitId)
            : null;
          item.canonicalSalesUnitId =
            candidate && isSalesUnitAssignable(candidate.deactivatedAt, item.paymentDate)
              ? candidate.id
              : null;
          item.updatedAt = nowIso();
        });
    });

    return {
      recalculatedOrderItems: this.databaseService
        .getSnapshot()
        .orderItems.filter((item) => item.storeId === storeId).length,
    };
  }
}

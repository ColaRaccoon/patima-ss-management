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
      recalculateOrderMappingsForStore(draft, storeId);
    });

    return {
      recalculatedOrderItems: this.databaseService
        .getSnapshot()
        .orderItems.filter((item) => item.storeId === storeId).length,
    };
  }
}

import { BadRequestException, Injectable } from "@nestjs/common";
import type { DailyFakePurchase } from "@patima/shared";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import { createId, ensureStoreExists, nowIso } from "./helpers";
import { StoreService } from "./store.service";

export interface DailyFakePurchaseResponse {
  amount: number;
  exists: boolean;
  updatedAt: string | null;
}

@Injectable()
export class FakePurchaseService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly storeService: StoreService,
    private readonly auditLogService: AuditLogService,
  ) {}

  get(storeId: string, date: string): DailyFakePurchaseResponse {
    this.validateStoreId(storeId);
    this.validateDate(date);

    const snapshot = this.databaseService.getSnapshot();
    ensureStoreExists(snapshot, storeId);

    const existing = snapshot.dailyFakePurchases.find(
      (row) => row.storeId === storeId && row.date === date,
    );

    if (!existing) {
      return {
        amount: 0,
        exists: false,
        updatedAt: null,
      };
    }

    return {
      amount: existing.amount,
      exists: true,
      updatedAt: existing.updatedAt,
    };
  }

  upsert(payload: { storeId: string; date: string; amount: number }): DailyFakePurchase {
    this.validateStoreId(payload.storeId);
    this.validateDate(payload.date);
    this.validateAmount(payload.amount);
    this.storeService.ensureWritable(payload.storeId);

    let previousAmount: number | null = null;
    const persisted = this.databaseService.write((draft) => {
      const existing = draft.dailyFakePurchases.find(
        (row) => row.storeId === payload.storeId && row.date === payload.date,
      );
      const timestamp = nowIso();

      if (existing) {
        previousAmount = existing.amount;
        existing.amount = payload.amount;
        existing.updatedAt = timestamp;
        return { ...existing };
      }

      const created: DailyFakePurchase = {
        id: createId(),
        storeId: payload.storeId,
        date: payload.date,
        amount: payload.amount,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      draft.dailyFakePurchases.push(created);
      return created;
    });

    this.auditLogService.record({
      storeId: payload.storeId,
      domain: "FAKE_PURCHASE",
      action: "UPSERT",
      targetId: `${payload.storeId}-${payload.date}`,
      actorIdentifier: "LOCALHOST_ADMIN",
      beforeJson: previousAmount,
      afterJson: payload.amount,
    });

    return persisted;
  }

  private validateStoreId(storeId: string) {
    if (!storeId?.trim()) {
      throw new BadRequestException({
        success: false,
        message: "스토어 ID가 필요합니다.",
        errors: [{ field: "storeId", reason: "STORE_ID_REQUIRED" }],
      });
    }
  }

  private validateDate(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
      throw new BadRequestException({
        success: false,
        message: "날짜 형식이 올바르지 않습니다.",
        errors: [{ field: "date", reason: "INVALID_DATE_FORMAT" }],
      });
    }
  }

  private validateAmount(amount: number) {
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
      throw new BadRequestException({
        success: false,
        message: "가구매 금액은 0 이상의 정수여야 합니다.",
        errors: [{ field: "amount", reason: "INVALID_AMOUNT" }],
      });
    }
  }
}

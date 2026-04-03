import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Store, normalizeText } from "@patima/shared";
import { AuditLogService } from "./audit-log.service";
import { DatabaseService } from "./database.service";
import { ensureStoreExists, createId, formatApiSuccess, nowIso } from "./helpers";
import { OperationService } from "./operation.service";

interface StorePayload {
  name: string;
  sellerAccountId: string;
  channelNo: string;
  memo?: string | null;
  platformType?: "NAVER_SMARTSTORE";
}

@Injectable()
export class StoreService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly auditLogService: AuditLogService,
    private readonly operationService: OperationService,
  ) {}

  list() {
    return formatApiSuccess(this.databaseService.getSnapshot().stores);
  }

  create(payload: StorePayload) {
    const platformType = payload.platformType ?? "NAVER_SMARTSTORE";
    if (!payload.name || !payload.sellerAccountId || !payload.channelNo) {
      throw new BadRequestException({
        success: false,
        message: "필수 스토어 값이 비어 있습니다.",
        errors: [{ field: "name", reason: "INVALID_VALUE" }],
      });
    }

    const snapshot = this.databaseService.getSnapshot();
    const duplicated = snapshot.stores.some(
      (item) =>
        item.platformType === platformType &&
        item.sellerAccountId === payload.sellerAccountId &&
        item.channelNo === payload.channelNo,
    );
    if (duplicated) {
      throw new BadRequestException({
        success: false,
        message: "같은 스토어가 이미 존재합니다.",
        errors: [{ field: "sellerAccountId", reason: "STORE_DUPLICATE" }],
      });
    }

    const created: Store = {
      id: createId(),
      name: payload.name,
      platformType,
      sellerAccountId: payload.sellerAccountId,
      channelNo: payload.channelNo,
      isPrimary: snapshot.stores.length === 0,
      isActive: true,
      deactivatedAt: null,
      memo: payload.memo ?? null,
      lastOrderSyncAt: null,
      lastOrderSyncStatus: "NEVER",
      credentialConnectionStatus: "NOT_TESTED",
      lastCredentialTestAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    this.databaseService.write((draft) => {
      draft.stores.push(created);
    });
    this.auditLogService.record({
      storeId: created.id,
      domain: "STORE",
      action: "CREATE",
      targetId: created.id,
      actorIdentifier: "LOCALHOST_ADMIN",
      beforeJson: null,
      afterJson: created,
    });

    return formatApiSuccess({
      storeId: created.id,
      name: created.name,
      platformType: created.platformType,
      sellerAccountId: created.sellerAccountId,
      channelNo: created.channelNo,
      isPrimary: created.isPrimary,
      isActive: created.isActive,
    });
  }

  update(storeId: string, payload: StorePayload) {
    this.ensureWritable(storeId);
    const previous = ensureStoreExists(this.databaseService.getSnapshot(), storeId);
    const duplicated = this.databaseService
      .getSnapshot()
      .stores.some(
        (item) =>
          item.id !== storeId &&
          item.platformType === (payload.platformType ?? previous.platformType) &&
          item.sellerAccountId === payload.sellerAccountId &&
          item.channelNo === payload.channelNo,
      );

    if (duplicated) {
      throw new BadRequestException({
        success: false,
        message: "같은 스토어가 이미 존재합니다.",
        errors: [{ field: "sellerAccountId", reason: "STORE_DUPLICATE" }],
      });
    }

    let updated!: Store;
    this.databaseService.write((draft) => {
      const store = ensureStoreExists(draft, storeId);
      store.name = payload.name;
      store.sellerAccountId = payload.sellerAccountId;
      store.channelNo = payload.channelNo;
      store.memo = payload.memo ?? null;
      store.updatedAt = nowIso();
      updated = { ...store };
    });

    this.auditLogService.record({
      storeId,
      domain: "STORE",
      action: "UPDATE",
      targetId: storeId,
      actorIdentifier: "LOCALHOST_ADMIN",
      beforeJson: previous,
      afterJson: updated,
    });

    return formatApiSuccess({
      storeId: updated.id,
      name: updated.name,
      sellerAccountId: updated.sellerAccountId,
      channelNo: updated.channelNo,
      isPrimary: updated.isPrimary,
      memo: updated.memo,
    });
  }

  setPrimary(storeId: string) {
    this.ensureWritable(storeId);
    let previousPrimaryStoreId: string | null = null;
    this.databaseService.write((draft) => {
      ensureStoreExists(draft, storeId);
      draft.stores.forEach((store) => {
        if (store.isPrimary && store.id !== storeId) {
          previousPrimaryStoreId = store.id;
        }
        store.isPrimary = store.id === storeId;
        store.updatedAt = nowIso();
      });
    });

    return formatApiSuccess({
      storeId,
      isPrimary: true,
      previousPrimaryStoreId,
    });
  }

  deactivate(storeId: string) {
    this.ensureWritable(storeId);
    let updated!: Store;
    this.databaseService.write((draft) => {
      const store = ensureStoreExists(draft, storeId);
      store.isActive = false;
      store.deactivatedAt = nowIso();
      store.updatedAt = nowIso();
      updated = { ...store };
    });

    return formatApiSuccess({
      storeId,
      isActive: false,
      deactivatedAt: updated.deactivatedAt,
    });
  }

  activate(storeId: string) {
    ensureStoreExists(this.databaseService.getSnapshot(), storeId);
    if (this.operationService.hasRunningOperation(storeId)) {
      throw new BadRequestException({
        success: false,
        message: "?ㅽ뻾 以묒씤 ?묒뾽???덉뼱 吏湲덉? ?곌린 ?묒뾽???????놁뒿?덈떎.",
        errors: [{ field: "storeId", reason: "STORE_WRITE_BUSY" }],
      });
    }

    let updated!: Store;
    this.databaseService.write((draft) => {
      const store = ensureStoreExists(draft, storeId);
      store.isActive = true;
      store.deactivatedAt = null;
      store.updatedAt = nowIso();
      updated = { ...store };
    });

    return formatApiSuccess({
      storeId,
      isActive: true,
      reactivatedAt: updated.updatedAt,
    });
  }

  ensureWritable(storeId: string) {
    const store = ensureStoreExists(this.databaseService.getSnapshot(), storeId);
    if (!store.isActive) {
      throw new BadRequestException({
        success: false,
        message: "비활성화된 스토어에는 쓰기 작업을 할 수 없습니다.",
        errors: [{ field: "storeId", reason: "STORE_INACTIVE" }],
      });
    }
    if (this.operationService.hasRunningOperation(storeId)) {
      throw new BadRequestException({
        success: false,
        message: "실행 중인 작업이 있어 지금은 쓰기 작업을 할 수 없습니다.",
        errors: [{ field: "storeId", reason: "STORE_WRITE_BUSY" }],
      });
    }
  }
}

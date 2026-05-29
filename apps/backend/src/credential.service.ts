import { BadRequestException, Injectable } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service";
import { CryptoService } from "./crypto.service";
import { DatabaseService } from "./database.service";
import { createId, ensureStoreExists, formatApiSuccess, nowIso } from "./helpers";
import { NaverCommerceService } from "./naver-commerce.service";
import { StoreService } from "./store.service";

@Injectable()
export class CredentialService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly cryptoService: CryptoService,
    private readonly auditLogService: AuditLogService,
    private readonly storeService: StoreService,
    private readonly naverCommerceService: NaverCommerceService,
  ) {}

  upsert(
    storeId: string,
    payload: { clientId: string; clientSecret: string; accessType?: "SELLER" },
  ) {
    this.storeService.ensureWritable(storeId);
    if (!payload.clientId || !payload.clientSecret) {
      throw new BadRequestException({
        success: false,
        message: "Client credentials are required.",
        errors: [{ field: "clientId", reason: "INVALID_CREDENTIALS" }],
      });
    }

    const encrypted = this.cryptoService.encrypt(payload.clientSecret);
    return this.upsertCommitted(storeId, payload, encrypted);
  }

  private async upsertCommitted(
    storeId: string,
    payload: { clientId: string; clientSecret: string; accessType?: "SELLER" },
    encrypted: string,
  ) {
    let credentialId = "";

    await this.databaseService.writeCommitted((draft) => {
      ensureStoreExists(draft, storeId);
      const existing = draft.commerceCredentials.find(
        (item) => item.storeId === storeId,
      );
      if (existing) {
        existing.clientId = payload.clientId;
        existing.clientSecretEncrypted = encrypted;
        existing.accessType = payload.accessType ?? "SELLER";
        existing.isEnabled = true;
        existing.updatedAt = nowIso();
        credentialId = existing.id;
      } else {
        const created = {
          id: createId(),
          storeId,
          clientId: payload.clientId,
          clientSecretEncrypted: encrypted,
          accessType: payload.accessType ?? "SELLER",
          isEnabled: true,
          lastTokenIssuedAt: null,
          lastTokenExpiresAt: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        draft.commerceCredentials.push(created);
        credentialId = created.id;
      }

      this.auditLogService.appendToDraft(draft, {
        storeId,
        domain: "COMMERCE_CREDENTIALS",
        action: "UPDATE",
        targetId: credentialId,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: null,
        afterJson: {
          maskedClientId: `${payload.clientId.slice(0, 8)}****`,
          accessType: payload.accessType ?? "SELLER",
        },
      });
    });

    return formatApiSuccess({
      credentialId,
      storeId,
      maskedClientId: `${payload.clientId.slice(0, 8)}****`,
      accessType: payload.accessType ?? "SELLER",
      secretStored: true,
    });
  }

  get(storeId: string) {
    const snapshot = this.databaseService.getSnapshot();
    const store = ensureStoreExists(snapshot, storeId);
    const resolved = this.naverCommerceService.getResolvedConfiguration(storeId);

    if (!resolved) {
      return formatApiSuccess({
        credentialId: null,
        storeId,
        maskedClientId: null,
        accessType: "SELLER",
        secretStored: false,
        credentialConnectionStatus: store.credentialConnectionStatus,
        lastCredentialTestAt: store.lastCredentialTestAt,
        credentialSource: "NONE",
      });
    }

    return formatApiSuccess({
      credentialId: resolved.credential.credentialId,
      storeId,
      maskedClientId: `${resolved.credential.clientId.slice(0, 8)}****`,
      accessType: resolved.credential.accessType,
      secretStored: true,
      credentialConnectionStatus: store.credentialConnectionStatus,
      lastCredentialTestAt: store.lastCredentialTestAt,
      credentialSource: resolved.credential.source,
    });
  }

  async test(storeId: string) {
    this.storeService.ensureWritable(storeId);
    const testedAt = nowIso();

    let result: Awaited<ReturnType<NaverCommerceService["testConnection"]>>;
    try {
      result = await this.naverCommerceService.testConnection(storeId);
    } catch (error) {
      await this.databaseService.writeCommitted((draft) => {
        const store = ensureStoreExists(draft, storeId);
        store.credentialConnectionStatus = "FAILED";
        store.lastCredentialTestAt = testedAt;
        store.updatedAt = testedAt;

        this.auditLogService.appendToDraft(draft, {
          storeId,
          domain: "COMMERCE_CREDENTIALS",
          action: "TEST_FAILED",
          targetId: null,
          actorIdentifier: "LOCALHOST_ADMIN",
          beforeJson: null,
          afterJson: {
            connectionStatus: "FAILED",
            error: error instanceof Error ? error.message : "UNKNOWN",
          },
        });
      });

      throw error;
    }

    await this.databaseService.writeCommitted((draft) => {
      const store = ensureStoreExists(draft, storeId);
      store.credentialConnectionStatus = "SUCCEEDED";
      store.lastCredentialTestAt = testedAt;
      store.updatedAt = testedAt;

      this.auditLogService.appendToDraft(draft, {
        storeId,
        domain: "COMMERCE_CREDENTIALS",
        action: "TEST",
        targetId: null,
        actorIdentifier: "LOCALHOST_ADMIN",
        beforeJson: null,
        afterJson: {
          connectionStatus: "SUCCEEDED",
          credentialSource: result.credentialSource,
          channelNo: result.channelNo,
          channelName: result.channelName,
        },
      });
    });

    return formatApiSuccess({
      storeId,
      connectionStatus: "SUCCEEDED",
      testedAt,
      ...result,
    });
  }
}

import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { CommerceCredential, DEFAULT_DELIVERY_UNIT_COST, Store } from "@patima/shared";
import { CryptoService } from "./crypto.service";
import { DatabaseService } from "./database.service";
import { createId, nowIso } from "./helpers";
import { NaverCommerceConfigService } from "./naver-commerce-config.service";

@Injectable()
export class EnvironmentBootstrapService implements OnApplicationBootstrap {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly cryptoService: CryptoService,
    private readonly naverCommerceConfigService: NaverCommerceConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const bootstrapStore = this.naverCommerceConfigService.getBootstrapStorePayload();
    if (!bootstrapStore) {
      return;
    }

    await this.databaseService.writeCommitted((draft) => {
      const now = nowIso();
      let store = draft.stores.find(
        (item) =>
          item.platformType === "NAVER_SMARTSTORE" &&
          item.sellerAccountId === bootstrapStore.sellerAccountId &&
          item.channelNo === bootstrapStore.channelNo,
      );

      if (!store) {
        store = {
          id: createId(),
          name: bootstrapStore.name,
          platformType: "NAVER_SMARTSTORE",
          sellerAccountId: bootstrapStore.sellerAccountId,
          channelNo: bootstrapStore.channelNo,
          isPrimary: draft.stores.length === 0,
          isActive: true,
          deactivatedAt: null,
          memo: bootstrapStore.memo,
          lastOrderSyncAt: null,
          lastOrderSyncStatus: "NEVER",
          credentialConnectionStatus: "NOT_TESTED",
          lastCredentialTestAt: null,
          deliveryUnitCost: DEFAULT_DELIVERY_UNIT_COST,
          createdAt: now,
          updatedAt: now,
        } satisfies Store;
        draft.stores.push(store);
      }

      const environmentCredential = this.naverCommerceConfigService.getEnvCredentialForStore(store);
      if (!environmentCredential) {
        return;
      }

      const encryptedSecret = this.cryptoService.encrypt(environmentCredential.clientSecret);
      let credential = draft.commerceCredentials.find((item) => item.storeId === store.id);
      if (!credential) {
        credential = {
          id: createId(),
          storeId: store.id,
          clientId: environmentCredential.clientId,
          clientSecretEncrypted: encryptedSecret,
          accessType: "SELLER",
          isEnabled: true,
          lastTokenIssuedAt: null,
          lastTokenExpiresAt: null,
          createdAt: now,
          updatedAt: now,
        } satisfies CommerceCredential;
        draft.commerceCredentials.push(credential);
        return;
      }

      credential.clientId = environmentCredential.clientId;
      credential.clientSecretEncrypted = encryptedSecret;
      credential.accessType = "SELLER";
      credential.isEnabled = true;
      credential.updatedAt = now;
    });
  }
}

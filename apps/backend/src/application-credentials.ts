import type { CommerceCredential, DatabaseShape } from "@patima/shared";
import { CryptoService } from "./crypto.service";

export function hasApplicationSecret(
  credential: Pick<CommerceCredential, "clientSecretEncrypted">,
  clientSecret: string,
  crypto: CryptoService,
): boolean {
  try {
    return crypto.decrypt(credential.clientSecretEncrypted) === clientSecret;
  } catch {
    return false;
  }
}

// The secret belongs to the application ID. Account/channel IDs and enabled
// flags remain specific to each store, including stores sharing an application.
export function synchronizeApplicationSecrets(
  database: DatabaseShape,
  clientId: string,
  clientSecret: string,
  crypto: CryptoService,
  timestamp: string,
): void {
  for (const credential of database.commerceCredentials) {
    if (credential.clientId !== clientId || hasApplicationSecret(credential, clientSecret, crypto)) continue;
    credential.clientSecretEncrypted = crypto.encrypt(clientSecret);
    credential.lastTokenIssuedAt = null;
    credential.lastTokenExpiresAt = null;
    credential.updatedAt = timestamp;
    const store = database.stores.find((item) => item.id === credential.storeId);
    if (store) {
      store.credentialConnectionStatus = "NOT_TESTED";
      store.lastCredentialTestAt = null;
      store.updatedAt = timestamp;
    }
  }
}

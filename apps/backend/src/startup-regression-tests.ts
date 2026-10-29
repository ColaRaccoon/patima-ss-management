import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { CryptoService } from "./crypto.service";
import { DatabaseService } from "./database.service";
import { EnvironmentBootstrapService } from "./environment-bootstrap.service";
import { createEmptyDatabase } from "./helpers";
import { NaverCommerceConfigService } from "./naver-commerce-config.service";

export async function runStartupRegressionTests() {
  const crypto = new CryptoService();
  const config = {
    getBootstrapStorePayload: () => ({ name: "Test", sellerAccountId: "seller", channelNo: "channel", memo: "" }),
    getEnvCredentialForStore: () => ({ clientId: "client", clientSecret: "secret" }),
  } as unknown as NaverCommerceConfigService;
  const fixture = () => {
    const data = createEmptyDatabase();
    data.stores.push({ id: "store", platformType: "NAVER_SMARTSTORE", sellerAccountId: "seller", channelNo: "channel" } as never);
    data.commerceCredentials.push({
      id: "credential", storeId: "store", clientId: "client", clientSecretEncrypted: crypto.encrypt("secret"),
      accessType: "SELLER", isEnabled: true, updatedAt: "2026-01-01T00:00:00Z",
    } as never);
    let writes = 0;
    const database = {
      getSnapshot: () => data,
      writeCommitted: async (mutator: (draft: typeof data) => void) => { writes++; mutator(data); },
    } as unknown as DatabaseService;
    return { data, database, writes: () => writes };
  };

  const unchanged = fixture();
  const original = structuredClone(unchanged.data);
  await new EnvironmentBootstrapService(unchanged.database, crypto, config).onApplicationBootstrap();
  assert.equal(unchanged.writes(), 0, "unchanged startup must not persist the full snapshot");
  assert.deepEqual(unchanged.data, original, "unchanged startup preserves ciphertext and timestamps");
  console.log("PASS startup skips unchanged credential persistence");

  for (const change of ["secret", "clientId", "disabled", "ciphertext", "credentialMissing", "storeMissing"]) {
    const state = fixture();
    const credential = state.data.commerceCredentials[0];
    if (change === "secret") credential.clientSecretEncrypted = crypto.encrypt("old-secret");
    if (change === "clientId") credential.clientId = "old-client";
    if (change === "disabled") credential.isEnabled = false;
    if (change === "ciphertext") credential.clientSecretEncrypted = "invalid";
    if (change === "credentialMissing") state.data.commerceCredentials = [];
    if (change === "storeMissing") { state.data.stores = []; state.data.commerceCredentials = []; }
    await new EnvironmentBootstrapService(state.database, crypto, config).onApplicationBootstrap();
    assert.equal(state.writes(), 1, `${change} must still be saved`);
    const saved = state.data.commerceCredentials[0];
    assert.equal(saved.clientId, "client");
    assert.equal(saved.isEnabled, true);
    assert.equal(crypto.decrypt(saved.clientSecretEncrypted), "secret");
  }
  console.log("PASS startup repairs changed and missing credentials");

  const directory = mkdtempSync(join(tmpdir(), "patima-startup-test-"));
  const overrides: Record<string, string | undefined> = {
    DATABASE_URL: undefined,
    DATA_DIR: directory,
    NAVER_BOOTSTRAP_STORE: "true",
    NAVER_CLIENT_ID: "startup-test-client",
    NAVER_CLIENT_SECRET: "startup-test-secret",
    NAVER_ACCOUNT_UID: "startup-test-seller",
    NAVER_CHANNEL_NO: "startup-test-channel",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    let firstSaved: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
      try {
        await app.listen(0, "127.0.0.1");
        const base = await app.getUrl();
        const health = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(5000) });
        assert.equal(health.status, 200);
        assert.equal((await health.json()).data.ok, true);
        const stores = await fetch(`${base}/api/v1/stores`, { signal: AbortSignal.timeout(5000) });
        assert.equal((await stores.json()).data.length, 1);
        const saved = JSON.parse(readFileSync(join(directory, "database.json"), "utf8")).commerceCredentials;
        if (attempt === 0) firstSaved = saved;
        else assert.deepEqual(saved, firstSaved, "restarting the complete app must preserve unchanged credentials");
      } finally {
        await app.close();
      }
    }
    console.log("PASS complete Nest app starts, serves HTTP and preserves credentials on restart");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

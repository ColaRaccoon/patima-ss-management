import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { CryptoService } from "./crypto.service";
import { DatabaseService, POSTGRES_SCHEMA_VERSION } from "./database.service";
import { EnvironmentBootstrapService } from "./environment-bootstrap.service";
import { createEmptyDatabase } from "./helpers";
import { NaverCommerceConfigService } from "./naver-commerce-config.service";
import { CredentialService } from "./credential.service";
import { NaverCommerceService, ResolvedCommerceCredential } from "./naver-commerce.service";
import { mock } from "node:test";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

async function runPostgresStartupTests() {
  const schemaFixture = (version?: number, indexesReady = true) => {
    const service = Object.create(DatabaseService.prototype) as any;
    const queries: string[] = [];
    const migrations: string[] = [];
    service.pool = { query: async (sql: string) => {
      queries.push(sql);
      return { rows: sql.startsWith("SELECT value") && version !== undefined
        ? [{ value: { version } }] : [] };
    } };
    service.backfillPostgresPayloadHashes = async () => { migrations.push("hashes"); };
    service.warnAboutDuplicateBusinessKeys = async () => { migrations.push("duplicates"); return []; };
    service.ensurePostgresIndexes = async () => { migrations.push("indexes"); return indexesReady; };
    return { service, queries, migrations };
  };
  const ready = schemaFixture(POSTGRES_SCHEMA_VERSION);
  await ready.service.ensurePostgresSchema();
  assert.equal(ready.queries.length, 2, "ready schema needs only metadata setup and a version read");
  assert.deepEqual(ready.migrations, [], "ordinary restarts must skip full-table migration scans");
  for (const version of [undefined, POSTGRES_SCHEMA_VERSION - 1]) {
    const upgrade = schemaFixture(version);
    await upgrade.service.ensurePostgresSchema();
    assert.deepEqual(upgrade.migrations, ["hashes", "duplicates", "indexes"]);
    assert.match(upgrade.queries.at(-1)!, /VALUES \('schema_ready'/);
  }
  for (const phase of ["backfillPostgresPayloadHashes", "ensurePostgresIndexes"]) {
    const failed = schemaFixture();
    failed.service[phase] = async () => { throw new Error("migration failed"); };
    await assert.rejects(() => failed.service.ensurePostgresSchema(), /migration failed/);
    assert.ok(!failed.queries.some((sql) => sql.includes("VALUES ('schema_ready'")),
      "a failed migration must run again on the next restart");
  }
  const duplicates = schemaFixture(undefined, false);
  await duplicates.service.ensurePostgresSchema();
  assert.ok(!duplicates.queries.some((sql) => sql.includes("VALUES ('schema_ready'")),
    "unique-index fallback must be retried after duplicate repair");
  console.log("PASS startup schema migrations run once per version and retry failures or duplicate fallbacks");

  for (const fail of [false, true]) {
    const service = Object.create(DatabaseService.prototype) as any;
    let active = 0;
    let peak = 0;
    let normalized = false;
    const tables: string[] = [];
    const published = createEmptyDatabase();
    service.database = published;
    service.pool = { query: async (sql: string) => {
      const table = /FROM (\w+)/.exec(sql)![1];
      tables.push(table);
      active++;
      peak = Math.max(peak, active);
      try {
        await yieldToEventLoop();
        if (fail && table === "order_items") throw new Error("table read failed");
        return { rows: [{ payload: { id: table } }] };
      } finally { active--; }
    } };
    service.normalizeSnapshot = (snapshot: ReturnType<typeof createEmptyDatabase>) => {
      assert.equal(active, 0, "normalization must wait for every table");
      normalized = true;
      return snapshot;
    };
    if (fail) {
      await assert.rejects(() => service.loadSnapshotFromPostgres(), /table read failed/);
      assert.equal(normalized, false, "failed loading must not normalize a partial snapshot");
    } else {
      const snapshot = await service.loadSnapshotFromPostgres();
      assert.equal(normalized, true);
      assert.equal(snapshot.stores[0].id, "stores");
      assert.equal(snapshot.orderItems[0].id, "order_items");
      assert.equal(snapshot.adCampaignDailyCosts[0].id, "ad_campaign_daily_costs");
      assert.equal(Object.values(snapshot).every((rows) => (rows as unknown[]).length === 1), true);
    }
    assert.equal(peak, 4, "startup must use bounded parallel reads");
    assert.equal(active, 0, "failed loading must also drain all workers");
    assert.equal(tables.length, new Set(tables).size, "tables must not load twice");
    assert.equal(service.database, published, "loading alone must not publish partial state");
  }
  console.log("PASS startup loads all tables with four workers and drains failed reads before rejecting");
}

export async function runStartupRegressionTests() {
  await runPostgresStartupTests();
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

  const sharedFixture = () => {
    const state = fixture();
    for (const [id, clientId, enabled] of [["sibling", "client", true], ["disabled", "client", false], ["other", "other-client", true]] as const) {
      state.data.stores.push({ id, sellerAccountId: `seller-${id}`, channelNo: `channel-${id}`, credentialConnectionStatus: "SUCCEEDED" } as never);
      state.data.commerceCredentials.push({ ...state.data.commerceCredentials[0], id, storeId: id, clientId, isEnabled: enabled, clientSecretEncrypted: crypto.encrypt("old-secret") });
    }
    return state;
  };
  const shared = sharedFixture();
  const independent = structuredClone(shared.data.commerceCredentials.find((item) => item.id === "other"));
  const accountBindings = shared.data.stores.map(({ id, sellerAccountId, channelNo }) => ({ id, sellerAccountId, channelNo }));
  await new EnvironmentBootstrapService(shared.database, crypto, config).onApplicationBootstrap();
  assert.equal(shared.writes(), 1, "stale sibling credentials must prevent the unchanged-primary early return");
  for (const item of shared.data.commerceCredentials.filter((item) => item.clientId === "client")) {
    assert.equal(crypto.decrypt(item.clientSecretEncrypted), "secret");
  }
  assert.equal(shared.data.commerceCredentials.find((item) => item.id === "disabled")?.isEnabled, false);
  assert.deepEqual(shared.data.commerceCredentials.find((item) => item.id === "other"), independent);
  assert.deepEqual(shared.data.stores.map(({ id, sellerAccountId, channelNo }) => ({ id, sellerAccountId, channelNo })), accountBindings);
  const afterRotation = structuredClone(shared.data);
  await new EnvironmentBootstrapService(shared.database, crypto, config).onApplicationBootstrap();
  assert.equal(shared.writes(), 1, "a subsequent unchanged startup must not write again");
  assert.deepEqual(shared.data, afterRotation);
  console.log("PASS environment rotation updates all stores sharing the app and preserves other app/store bindings");

  const fromUi = sharedFixture();
  const credentialService = new CredentialService(fromUi.database, crypto, { appendToDraft: () => {} } as never, { ensureWritable: () => {} } as never, {} as never);
  await credentialService.upsert("sibling", { clientId: "client", clientSecret: "ui-rotated-secret" });
  for (const item of fromUi.data.commerceCredentials.filter((item) => item.clientId === "client")) {
    assert.equal(crypto.decrypt(item.clientSecretEncrypted), "ui-rotated-secret");
  }
  assert.equal(crypto.decrypt(fromUi.data.commerceCredentials.find((item) => item.id === "other")!.clientSecretEncrypted), "old-secret");
  assert.equal(fromUi.data.commerceCredentials.find((item) => item.id === "disabled")?.isEnabled, false);
  console.log("PASS saving credentials propagates the application secret without enabling disabled stores");

  let tokenRequests = 0;
  const authorization: string[] = [];
  const activeCredential: ResolvedCommerceCredential = { credentialId: null, clientId: "client", clientSecret: "$2a$04$abcdefghijklmnopqrstuv", accessType: "SELLER", source: "ENV" };
  const commerce = new NaverCommerceService({} as never, crypto, config);
  commerce.getResolvedConfiguration = () => ({ store: { sellerAccountId: "seller", channelNo: "channel" } as never, credential: activeCredential });
  const fetchMock = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/oauth2/token")) {
      tokenRequests++;
      assert.equal(new URLSearchParams(String(init?.body)).get("account_id"), "seller");
      return Response.json({ access_token: `token-${tokenRequests}`, expires_in: 3600 });
    }
    authorization.push(new Headers(init?.headers).get("Authorization") ?? "");
    return Response.json([{ channelNo: "channel", channelName: "Store" }]);
  });
  try {
    await commerce.testConnection("store");
    await commerce.testConnection("store");
    activeCredential.clientSecret = "$2a$04$zyxwvutsrqponmlkjihgfe";
    await commerce.testConnection("store");
    assert.equal(tokenRequests, 2, "rotating a secret must bypass the token cached under the old secret");
    assert.deepEqual(authorization, ["Bearer token-1", "Bearer token-1", "Bearer token-2"]);
  } finally {
    fetchMock.mock.restore();
  }
  console.log("PASS token cache renews after secret rotation while retaining the store account");

  const tokenState = fixture();
  let tokenTables: ReadonlyArray<string> | undefined;
  const commitToken = tokenState.database.writeCommitted.bind(tokenState.database);
  tokenState.database.writeCommitted = async (mutator, tables) => {
    tokenTables = tables;
    return commitToken(mutator, tables);
  };
  const persistedCommerce = new NaverCommerceService(tokenState.database, crypto, config);
  persistedCommerce.getResolvedConfiguration = () => ({
    store: tokenState.data.stores[0],
    credential: { ...activeCredential, credentialId: "credential", source: "DATABASE" },
  });
  const tokenFetch = mock.method(globalThis, "fetch", async (url: string | URL | Request) =>
    String(url).endsWith("/oauth2/token")
      ? Response.json({ access_token: "persisted-token", expires_in: 3600 })
      : Response.json([{ channelNo: "channel" }]),
  );
  try {
    await persistedCommerce.testConnection("store");
    assert.deepEqual(tokenTables, ["commerceCredentials"]);
    assert.ok(tokenState.data.commerceCredentials[0].lastTokenIssuedAt);
  } finally {
    tokenFetch.mock.restore();
  }
  console.log("PASS database token renewal persists credentials without uploading order history");

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

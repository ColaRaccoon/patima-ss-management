import assert from "node:assert/strict";
import { createSourceSignature, normalizeText } from "@patima/shared";
import { evaluateAdMapping, getAdMappingOverride } from "./ad-mapping-engine";
import {
  calculateFee,
  createEmptyDatabase,
  getWeekdayNameKo,
  saleStatusFromNaverOrderState,
  saleStatusFromRawStatus,
} from "./helpers";
import { NaverCommerceConfigService } from "./naver-commerce-config.service";
import { createNaverClientSecretSign } from "./naver-commerce.service";
import { recalculateOrderMappingsForStore, resolveOrderSignatureAutoMapping } from "./sales-unit-auto-mapper";

const run = (name: string, fn: () => void) => {
  fn();
  console.log(`PASS ${name}`);
};

run("normalizeText keeps prefixes and symbols while normalizing whitespace and case", () => {
  assert.equal(
    normalizeText("  [함께배송]\n러닝모자: BLACK  "),
    "[함께배송] 러닝모자: black",
  );
});

run("getWeekdayNameKo resolves KST weekday correctly", () => {
  assert.equal(getWeekdayNameKo("2026-03-23"), "월요일");
});

run("saleStatusFromRawStatus maps cancel request correctly", () => {
  assert.equal(saleStatusFromRawStatus("CANCEL_REQUEST"), "CANCEL_REQUESTED");
});

run("saleStatusFromNaverOrderState prioritizes claim status over product order status", () => {
  assert.equal(saleStatusFromNaverOrderState("PAYED", "RETURN_REQUEST"), "RETURNED");
});

run("createNaverClientSecretSign produces a base64 bcrypt signature", () => {
  const signature = createNaverClientSecretSign(
    "aaaabbbbcccc",
    "$2a$04$abcdefghijklmnopqrstuv",
    "1643961623299",
  );
  assert.equal(
    signature,
    "JDJhJDA0JGFiY2RlZmdoaWprbG1ub3BxcnN0dXV6NDlObEtMdDYyUWhPdnNjSTNNWnR4ZUlDQjNoYUpD",
  );
});

run("NaverCommerceConfigService resolves matching env credentials", () => {
  const original = {
    NAVER_CLIENT_ID: process.env.NAVER_CLIENT_ID,
    NAVER_CLIENT_SECRET: process.env.NAVER_CLIENT_SECRET,
    NAVER_ACCOUNT_UID: process.env.NAVER_ACCOUNT_UID,
    NAVER_CHANNEL_NO: process.env.NAVER_CHANNEL_NO,
    NAVER_SOLUTION_ID: process.env.NAVER_SOLUTION_ID,
    NAVER_CALLBACK_URL: process.env.NAVER_CALLBACK_URL,
    NAVER_BOOTSTRAP_STORE: process.env.NAVER_BOOTSTRAP_STORE,
    NAVER_STORE_NAME: process.env.NAVER_STORE_NAME,
  };

  process.env.NAVER_CLIENT_ID = "env-client-id";
  process.env.NAVER_CLIENT_SECRET = "env-client-secret";
  process.env.NAVER_ACCOUNT_UID = "env-account";
  process.env.NAVER_CHANNEL_NO = "1001";
  process.env.NAVER_SOLUTION_ID = "sol-1";
  process.env.NAVER_CALLBACK_URL = "https://example.com/naver/callback";

  const service = new NaverCommerceConfigService();
  const resolved = service.getEnvCredentialForStore({
    sellerAccountId: "env-account",
    channelNo: "1001",
  } as never);

  assert.equal(resolved?.clientId, "env-client-id");
  assert.equal(resolved?.accountUid, "env-account");
  assert.equal(resolved?.channelNo, "1001");
  assert.equal(resolved?.solutionId, "sol-1");

  Object.entries(original).forEach(([key, value]) => {
    if (value == null) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  });
});

run("calculateFee falls back to feeRate only when both API fees are null", () => {
  const result = calculateFee(
    {
      paymentCommission: null,
      knowledgeShoppingSellingInterlockCommission: null,
      productPaymentAmount: 10000,
    } as never,
    {
      feeRate: 0.035,
    } as never,
  );
  assert.equal(result.totalFeeCost, 350);
  assert.equal(result.usedFallback, true);
  assert.equal(result.incomplete, false);
});

run("getAdMappingOverride returns manual mapped rows as overrides", () => {
  assert.deepEqual(
    getAdMappingOverride({
      canonicalSalesUnitId: "sales-1",
      mappingReason: "MANUAL_MAPPED",
      reasonNote: null,
    } as never),
    {
      type: "MANUAL_MAPPED",
      canonicalSalesUnitId: "sales-1",
    },
  );
});

run("evaluateAdMapping preserves manual overrides ahead of rule matching", () => {
  const database = createEmptyDatabase();
  database.canonicalSalesUnits.push({
    id: "sales-1",
    storeId: "store-1",
    isActive: true,
  } as never);
  database.campaignMappings.push({
    id: "mapping-1",
    storeId: "store-1",
    canonicalSalesUnitId: "sales-2",
    normalizedCampaignPattern: "alpha",
    isActive: true,
  } as never);

  const result = evaluateAdMapping(database, "store-1", "alpha campaign", {
    type: "MANUAL_MAPPED",
    canonicalSalesUnitId: "sales-1",
  });

  assert.equal(result.canonicalSalesUnitId, "sales-1");
  assert.equal(result.mappingReason, "MANUAL_MAPPED");
  assert.equal(result.matchedRuleCount, 0);
});

run("resolveOrderSignatureAutoMapping matches shortened product names to a unique sales unit", () => {
  const salesUnits = [
    {
      id: "sales-1",
      standardProductName: "\uB450\uC904\uBB34\uB98E\uBCF4\uD638\uB300",
      standardOptionName: null,
      normalizedStandardProductName: normalizeText("\uB450\uC904\uBB34\uB98E\uBCF4\uD638\uB300"),
      normalizedStandardOptionName: "",
      displayName: "\uB450\uC904\uBB34\uB98E\uBCF4\uD638\uB300",
      normalizedDisplayName: normalizeText("\uB450\uC904\uBB34\uB98E\uBCF4\uD638\uB300"),
      isActive: true,
    },
  ] as never[];

  const result = resolveOrderSignatureAutoMapping(salesUnits, {
    normalizedProductName: normalizeText("\uB450\uC904 \uBCF4\uD638\uB300"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("\uB450\uC904 \uBCF4\uD638\uB300", null),
  } as never);

  assert.equal(result.canonicalSalesUnitId, "sales-1");
  assert.equal(result.ambiguous, false);
});

run("recalculateOrderMappingsForStore leaves ambiguous shortened names unmapped", () => {
  const database = createEmptyDatabase();
  database.canonicalSalesUnits.push(
    {
      id: "sales-1",
      storeId: "store-1",
      standardProductName: "\uB450\uC904\uBB34\uB98E\uBCF4\uD638\uB300",
      standardOptionName: null,
      normalizedStandardProductName: normalizeText("\uB450\uC904\uBB34\uB98E\uBCF4\uD638\uB300"),
      normalizedStandardOptionName: "",
      displayName: "\uB450\uC904\uBB34\uB98E\uBCF4\uD638\uB300",
      normalizedDisplayName: normalizeText("\uB450\uC904\uBB34\uB98E\uBCF4\uD638\uB300"),
      isActive: true,
    } as never,
    {
      id: "sales-2",
      storeId: "store-1",
      standardProductName: "\uB450\uC904\uC190\uBAA9\uBCF4\uD638\uB300",
      standardOptionName: null,
      normalizedStandardProductName: normalizeText("\uB450\uC904\uC190\uBAA9\uBCF4\uD638\uB300"),
      normalizedStandardOptionName: "",
      displayName: "\uB450\uC904\uC190\uBAA9\uBCF4\uD638\uB300",
      normalizedDisplayName: normalizeText("\uB450\uC904\uC190\uBAA9\uBCF4\uD638\uB300"),
      isActive: true,
    } as never,
  );
  database.orderSourceSignatures.push({
    id: "signature-1",
    storeId: "store-1",
    rawProductNameSnapshot: "\uB450\uC904 \uBCF4\uD638\uB300",
    rawOptionInfoSnapshot: null,
    normalizedProductName: normalizeText("\uB450\uC904 \uBCF4\uD638\uB300"),
    normalizedOptionInfo: "",
    sourceSignature: createSourceSignature("\uB450\uC904 \uBCF4\uD638\uB300", null),
    canonicalSalesUnitId: null,
    confirmedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never);

  recalculateOrderMappingsForStore(database, "store-1");

  assert.equal(database.orderSourceSignatures[0].canonicalSalesUnitId, null);
});

run("evaluateAdMapping falls back to sales-unit name matching without a campaign rule", () => {
  const database = createEmptyDatabase();
  database.canonicalSalesUnits.push({
    id: "sales-1",
    storeId: "store-1",
    standardProductName: "\uB450\uC904\uBB34\uB98E\uBCF4\uD638\uB300",
    standardOptionName: null,
    normalizedStandardProductName: normalizeText("\uB450\uC904\uBB34\uB98E\uBCF4\uD638\uB300"),
    normalizedStandardOptionName: "",
    displayName: "\uB450\uC904\uBB34\uB98E\uBCF4\uD638\uB300",
    normalizedDisplayName: normalizeText("\uB450\uC904\uBB34\uB98E\uBCF4\uD638\uB300"),
    isActive: true,
  } as never);

  const result = evaluateAdMapping(database, "store-1", normalizeText("\uB450\uC904 \uBCF4\uD638\uB300"));

  assert.equal(result.canonicalSalesUnitId, "sales-1");
  assert.equal(result.mappingReason, "RULE_MATCHED");
});

console.log("All backend checks passed.");

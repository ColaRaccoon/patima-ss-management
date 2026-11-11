import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { AdCampaignDailyCost, AdCampaignSignature, CanonicalSalesUnit } from "@patima/shared";
import { createEmptyDatabase } from "../apps/backend/src/helpers";
import {
  createAdCampaignSignatureIndex,
  recalculateAdCampaignSignaturesForStore,
  upsertAdCampaignSignature,
} from "../apps/backend/src/ad-mapping-engine";

// Isolated synthetic data only. Both paths use the current matcher; this measures
// signature lookup and historical row-scan savings, excluding database persistence.
const historicalSignatures = 15_000;
const historicalRows = 60_000;
const importedRows = 500;
const timestamp = "2026-11-10T00:00:00.000Z";
const database = createEmptyDatabase();
database.canonicalSalesUnits = Array.from({ length: 30 }, (_, i) => ({
  id: `unit-${i}`, storeId: "store", isActive: true, parentSalesUnitId: null,
  normalizedMatchAliases: [`product-${i}-`],
} as CanonicalSalesUnit));
database.adCampaignSignatures = Array.from({ length: historicalSignatures }, (_, i) => ({
  id: `signature-${i}`, storeId: "store", channel: "NAVER_DA", campaignId: `campaign-${i}`,
  campaignNameSnapshot: `product-${i % 30}-campaign`, normalizedCampaignName: `product-${i % 30}-campaign`,
  canonicalSalesUnitId: null, mappingReason: "NO_RULE", matchedRuleCount: 0, reasonNote: null,
  reasonNoteInherited: false, confirmedAt: null, usageCount: 4, firstSeenDate: "2026-11-09", lastSeenDate: "2026-11-09",
  lastAutoMappedAt: null, mappingRuleHash: null, createdAt: timestamp, updatedAt: timestamp,
} as AdCampaignSignature));
database.adCampaignDailyCosts = Array.from({ length: historicalRows }, (_, i) => ({
  id: `history-${i}`, storeId: "store", reportDate: "2026-11-09", adCampaignSignatureId: `signature-${i % historicalSignatures}`,
  campaignId: `campaign-${i % historicalSignatures}`, canonicalSalesUnitId: null, mappingReason: "NO_RULE", updatedAt: timestamp,
} as AdCampaignDailyCost));

function measure(indexed: boolean) {
  const draft = structuredClone(database);
  const start = performance.now();
  const index = indexed ? createAdCampaignSignatureIndex(draft) : undefined;
  const rows: AdCampaignDailyCost[] = [];
  const signatureIds = new Set<string>();
  for (let i = historicalSignatures - importedRows; i < historicalSignatures; i++) {
    const signature = upsertAdCampaignSignature(draft, {
      storeId: "store", campaignId: `campaign-${i}`, campaignName: `product-${i % 30}-campaign`, reportDate: "2026-11-10",
    }, index);
    signatureIds.add(signature.id);
    const row = {
      id: `import-${i}`, storeId: "store", reportDate: "2026-11-10", adCampaignSignatureId: signature.id,
      campaignId: `campaign-${i}`, canonicalSalesUnitId: null, mappingReason: "NO_RULE", updatedAt: timestamp,
    } as AdCampaignDailyCost;
    draft.adCampaignDailyCosts.push(row);
    rows.push(row);
  }
  recalculateAdCampaignSignaturesForStore(draft, "store", {
    signatureIds, applyToRowsFrom: "2026-11-10", applyToRowsTo: "2026-11-10", ...(indexed ? { rows } : {}),
  });
  const elapsedMs = performance.now() - start;
  return {
    elapsedMs,
    results: rows.map((row) => ({
      campaignId: row.campaignId, canonicalSalesUnitId: row.canonicalSalesUnitId,
      mappingReason: row.mappingReason, matchedRuleCount: row.matchedRuleCount,
    })),
  };
}

const baselineTimes: number[] = [];
const indexedTimes: number[] = [];
for (let attempt = 0; attempt < 3; attempt++) {
  const baseline = measure(false);
  const indexed = measure(true);
  assert.deepEqual(indexed.results, baseline.results);
  baselineTimes.push(baseline.elapsedMs);
  indexedTimes.push(indexed.elapsedMs);
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[1];
const baselineMedian = median(baselineTimes);
const indexedMedian = median(indexedTimes);
console.log(JSON.stringify({
  historicalSignatures, historicalRows, importedRows, repetitions: 3,
  baseline: "linear signature upserts + full historical row scans (current matcher)",
  optimized: "shared signature index + imported-row scope (current matcher)",
  baselineMs: baselineTimes.map((value) => Math.round(value)),
  optimizedMs: indexedTimes.map((value) => Math.round(value)),
  baselineMedianMs: Math.round(baselineMedian), optimizedMedianMs: Math.round(indexedMedian),
  speedup: Number((baselineMedian / indexedMedian).toFixed(1)), equalMappings: true,
  excludes: "Excel parsing, snapshot clone, persistence and profit summary recomputation",
}, null, 2));

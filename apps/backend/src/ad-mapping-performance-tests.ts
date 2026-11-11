import assert from "node:assert/strict";
import type { AdCampaignDailyCost, CanonicalSalesUnit, CampaignSalesUnitMapping } from "@patima/shared";
import {
  createAdCampaignSignatureIndex,
  ensureAdCampaignSignaturesForStore,
  evaluateAdMapping,
  getActiveCampaignMappings,
  getAutoMatchSalesUnitsSnapshot,
  getRuleSnapshotHash,
  recalculateAdCampaignSignaturesForStore,
  upsertAdCampaignSignature,
} from "./ad-mapping-engine";
import { createEmptyDatabase, hashJson } from "./helpers";

const timestamp = "2026-11-11T00:00:00.000Z";
const unit = (id: string, extra: Partial<CanonicalSalesUnit> = {}): CanonicalSalesUnit => ({
  id, storeId: "s", isActive: true, parentSalesUnitId: null,
  normalizedMatchAliases: [id], ...extra,
} as CanonicalSalesUnit);
const row = (id: string, campaignId: string, extra: Partial<AdCampaignDailyCost> = {}): AdCampaignDailyCost => ({
  id, storeId: "s", reportDate: "2026-11-10", campaignId, campaignName: "group campaign",
  normalizedCampaignName: "group campaign", canonicalSalesUnitId: null,
  mappingReason: "NO_RULE", matchedRuleCount: 0, reasonNote: "일치하는 규칙이 없습니다.",
  reasonNoteInherited: false, createdAt: timestamp, updatedAt: timestamp,
  ...extra,
} as AdCampaignDailyCost);

export function runAdMappingPerformanceTests() {
  {
    const database = createEmptyDatabase();
    const index = createAdCampaignSignatureIndex(database);
    Object.defineProperty(database.adCampaignSignatures, "find", {
      value: () => { throw new Error("Indexed upserts must not scan the signature list"); },
    });
    const first = upsertAdCampaignSignature(database, {
      storeId: "s", campaignId: " campaign-1 ", campaignName: "before", reportDate: "2026-11-10",
    }, index);
    const same = upsertAdCampaignSignature(database, {
      storeId: "s", campaignId: "campaign-1", campaignName: "after", reportDate: "2026-11-09",
    }, index);
    upsertAdCampaignSignature(database, {
      storeId: "s", campaignId: "campaign-1", campaignName: "after", reportDate: "2026-11-11", countUsage: false,
    }, index);
    assert.strictEqual(first, same);
    assert.equal(first.campaignNameSnapshot, "after");
    assert.equal(first.usageCount, 2);
    assert.equal(first.firstSeenDate, "2026-11-09");
    assert.equal(first.lastSeenDate, "2026-11-11");
    const nameOnly = upsertAdCampaignSignature(database, { storeId: "s", campaignName: "name only" }, index);
    assert.strictEqual(nameOnly, upsertAdCampaignSignature(database, { storeId: "s", campaignName: "name only" }, index));
    const otherStore = upsertAdCampaignSignature(database, { storeId: "other", campaignId: "campaign-1", campaignName: "after" }, index);
    assert.notEqual(otherStore.id, first.id);
    assert.equal(database.adCampaignSignatures.length, 3);
    console.log("PASS indexed ad signature upserts retain identity, usage, dates and store isolation");
  }

  {
    const database = createEmptyDatabase();
    database.adCampaignDailyCosts = Array.from({ length: 300 }, (_, i) => row(`row-${i}`, "same-id"));
    Object.defineProperty(database.adCampaignSignatures, "find", {
      value: () => { throw new Error("Legacy materialization must not scan signatures per row"); },
    });
    const touched = ensureAdCampaignSignaturesForStore(database, "s");
    assert.equal(touched.size, 1);
    assert.equal(database.adCampaignSignatures.length, 1);
    assert.equal(database.adCampaignSignatures[0].usageCount, 300);
    ensureAdCampaignSignaturesForStore(database, "s");
    assert.equal(database.adCampaignSignatures[0].usageCount, 300, "already linked rows do not count twice");
    console.log("PASS legacy ad signature materialization uses one index and is idempotent");
  }

  {
    const database = createEmptyDatabase();
    database.canonicalSalesUnits.push(unit("group", { isGroup: true }));
    const signature = upsertAdCampaignSignature(database, { storeId: "s", campaignId: "existing", campaignName: "group campaign" });
    const previous = row("previous", "existing", { adCampaignSignatureId: signature.id, reportDate: "2026-11-09" });
    const imported = row("imported", "existing", { adCampaignSignatureId: signature.id });
    const legacy = row("legacy", "unrelated");
    const other = row("other-store", "existing", { storeId: "other", adCampaignSignatureId: signature.id });
    database.adCampaignDailyCosts.push(previous, imported, legacy, other);
    const unchanged = structuredClone([previous, legacy, other]);
    recalculateAdCampaignSignaturesForStore(database, "s", {
      signatureIds: [signature.id], applyToRows: true, rows: [imported, other],
    });
    assert.equal(imported.canonicalSalesUnitId, "group");
    assert.deepEqual([previous, legacy, other], unchanged, "scoped upload never rewrites historical/unrelated rows");
    assert.equal(database.adCampaignSignatures.length, 1, "unrelated legacy rows are not materialized");
    signature.confirmedAt = timestamp;
    signature.mappingReason = "INTENTIONALLY_UNMAPPED";
    signature.canonicalSalesUnitId = null;
    signature.reasonNote = "manual decision";
    recalculateAdCampaignSignaturesForStore(database, "s", { signatureIds: [signature.id], applyToRows: true, rows: [imported] });
    assert.equal(imported.mappingReason, "INTENTIONALLY_UNMAPPED");
    assert.equal(imported.reasonNote, "manual decision");
    recalculateAdCampaignSignaturesForStore(database, "s", { applyToRows: true });
    assert.ok(legacy.adCampaignSignatureId, "the default full-store path still repairs legacy rows");
    assert.equal(legacy.canonicalSalesUnitId, "group");
    console.log("PASS upload-scoped ad mapping preserves manual choices and untouched history; full repair still works");
  }

  {
    const database = createEmptyDatabase();
    database.canonicalSalesUnits.push(unit("group", { isGroup: true }), unit("child", { parentSalesUnitId: "group" }), unit("other"));
    database.campaignMappings.push({
      id: "explicit", storeId: "s", isActive: true, normalizedCampaignPattern: "explicit", canonicalSalesUnitId: "child",
    } as CampaignSalesUnitMapping);
    const expectedHash = hashJson({
      explicitRules: getActiveCampaignMappings(database, "s").map((mapping) => ({
        id: mapping.id, normalizedCampaignPattern: mapping.normalizedCampaignPattern, canonicalSalesUnitId: mapping.canonicalSalesUnitId,
      })),
      autoMatchSalesUnits: getAutoMatchSalesUnitsSnapshot(database, "s"),
    });
    assert.equal(getRuleSnapshotHash(database, "s"), expectedHash, "existing persisted mapping hashes stay compatible");
    const names = ["explicit child", "group child", "other", "group other", "unknown"];
    const expected = names.map((name) => evaluateAdMapping(database, "s", name));
    const index = createAdCampaignSignatureIndex(database);
    for (let i = 0; i < 500; i++) {
      upsertAdCampaignSignature(database, { storeId: "s", campaignId: `id-${i}`, campaignName: names[i % names.length] }, index);
    }
    const units = database.canonicalSalesUnits;
    let collectionReads = 0;
    Object.defineProperty(database, "canonicalSalesUnits", { get() { collectionReads++; return units; } });
    recalculateAdCampaignSignaturesForStore(database, "s");
    assert.ok(collectionReads <= 3, `mapping context should be built once, observed ${collectionReads} collection reads`);
    database.adCampaignSignatures.forEach((signature, i) => {
      const mapping = expected[i % names.length];
      assert.equal(signature.canonicalSalesUnitId, mapping.canonicalSalesUnitId);
      assert.equal(signature.mappingReason, mapping.mappingReason);
      assert.equal(signature.matchedRuleCount, mapping.matchedRuleCount);
      assert.equal(signature.mappingRuleHash, expectedHash);
    });
    console.log("PASS ad mapping batch shares one rule/unit context without changing matching or hashes");
  }
}

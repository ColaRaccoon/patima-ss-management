import assert from "node:assert/strict";
import { CanonicalSalesUnit, DatabaseShape } from "@patima/shared";
import { CampaignMappingService } from "./campaign-mapping.service";
import { createEmptyDatabase } from "./helpers";

export async function runCampaignMappingBatchTests() {
  let database = createEmptyDatabase();
  database.canonicalSalesUnits = [
    { id: "one", storeId: "store", parentSalesUnitId: null },
    { id: "two", storeId: "store", parentSalesUnitId: null },
    { id: "child", storeId: "store", parentSalesUnitId: "one" },
    { id: "foreign", storeId: "other", parentSalesUnitId: null },
  ] as CanonicalSalesUnit[];
  const scopes: unknown[] = [];
  const operations: unknown[] = [];
  let failPersistence = false;
  let beforeWrite: (() => void) | undefined;
  const service = new CampaignMappingService(
    {
      getSnapshot: () => database,
      writeCommitted: async <T>(mutator: (draft: DatabaseShape) => T, scope: unknown) => {
        beforeWrite?.();
        const draft = structuredClone(database);
        const result = mutator(draft);
        if (failPersistence) throw new Error("persistence failed");
        scopes.push(scope);
        database = draft;
        return result;
      },
    } as never,
    { ensureWritable: (id: string) => assert.equal(id, "store") } as never,
    { enqueue: async (...args: unknown[]) => { operations.push(args); return { id: "operation" }; } } as never,
    {} as never,
    {} as never,
  );
  const rule = (campaignPattern: string, canonicalSalesUnitId = "one") => ({ campaignPattern, canonicalSalesUnitId });
  const batch = (rules: ReturnType<typeof rule>[]) => service.createBatch({ storeId: "store", rules });
  const result = await batch([rule("first"), rule("second", "two")]);
  assert.equal(result.data.mappings.length, 2);
  assert.equal(result.data.operationId, "operation");
  assert.deepEqual(scopes, [["campaignMappings"]]);
  assert.equal(operations.length, 1);

  for (const invalid of [rule("x"), rule("missing", "missing"), rule("child", "child"), rule("foreign", "foreign"), rule("first")]) {
    await assert.rejects(batch([rule("valid"), invalid]));
    assert.equal(database.campaignMappings.length, 2, "invalid batches must not partially persist");
  }
  await assert.rejects(batch([rule("DUPLICATE"), rule("duplicate")]));
  await assert.rejects(batch([]));
  assert.equal(scopes.length, 1);
  assert.equal(operations.length, 1);

  const originalId = database.campaignMappings[0].id;
  database.campaignMappings[0].isActive = false;
  database.campaignMappings[0].deactivatedAt = new Date().toISOString();
  const single = await service.create({ storeId: "store", ...rule("FIRST", "two") });
  assert.equal(single.data.id, originalId);
  assert.equal(single.data.canonicalSalesUnitId, "two");
  assert.equal(single.data.deactivatedAt, null);
  assert.equal(single.data.isActive, true);
  assert.equal(database.campaignMappings.length, 2);
  assert.deepEqual(scopes[1], ["campaignMappings"]);

  failPersistence = true;
  await assert.rejects(batch([rule("newone"), rule("newtwo")]), /persistence failed/);
  assert.equal(database.campaignMappings.length, 2);
  assert.equal(operations.length, 2, "failed persistence must not schedule recalculation");
  failPersistence = false;

  database.campaignMappings[0].isActive = false;
  beforeWrite = () => { database.campaignMappings[0].isActive = true; };
  await assert.rejects(batch([rule("first", "one")]));
  assert.equal(database.campaignMappings[0].canonicalSalesUnitId, "two", "queued requests must revalidate duplicates");
  assert.equal(operations.length, 2);
}

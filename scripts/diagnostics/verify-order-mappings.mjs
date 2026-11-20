// Build the backend first, then run from the repository root:
// node scripts/diagnostics/verify-order-mappings.mjs
// Loads only mapping inputs in a read-only transaction. No snapshots or customer data are written.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();
const require = createRequire(import.meta.url);
const { createEmptyDatabase, migrateCanonicalSalesUnit } = require('../../apps/backend/dist/apps/backend/src/helpers.js');
const { recalculateOrderMappingsForStore } = require('../../apps/backend/dist/apps/backend/src/sales-unit-auto-mapper.js');
const { createOrderGroupContext, matchOrderGroup } = require('../../apps/backend/dist/apps/backend/src/order-group-matcher.js');

async function main() {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  const database = createEmptyDatabase();
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    options: '-c default_transaction_read_only=on',
    connectionTimeoutMillis: 10000,
    statement_timeout: 60000,
  });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    database.canonicalSalesUnits = (await client.query('SELECT payload FROM canonical_sales_units')).rows
      .map(({ payload }) => migrateCanonicalSalesUnit(payload));
    database.orderSourceSignatures = (await client.query('SELECT payload FROM order_source_signatures')).rows
      .map(({ payload }) => payload);
    // Select only fields consumed by the mapper; never retrieve raw API payloads or buyer information.
    const fields = ['id', 'storeId', 'orderSourceSignatureId', 'canonicalSalesUnitId',
      'externalProductId', 'optionCode', 'optionManageCode', 'rawProductName', 'rawOptionInfo',
      'normalizedProductName', 'normalizedOptionInfo', 'sourceSignature', 'paymentDate', 'updatedAt'];
    const select = fields.map((field) => `'${field}', payload->'${field}'`).join(', ');
    database.orderItems = (await client.query(`SELECT jsonb_build_object(${select}) AS payload FROM order_items`)).rows
      .map(({ payload }) => payload);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }

  const storeIds = [...new Set(database.orderItems.map((item) => item.storeId))];
  const original = structuredClone(database);
  const beforeItems = new Map(original.orderItems.map((item) => [item.id, item.canonicalSalesUnitId]));
  const manual = new Map(original.orderSourceSignatures.filter((signature) => signature.confirmedAt)
    .map((signature) => [signature.id, JSON.stringify(signature)]));
  const businessState = (data) => JSON.stringify({
    signatures: data.orderSourceSignatures.map((signature) => [signature.id, signature.canonicalSalesUnitId,
      signature.mappingStatus, signature.confirmedAt]).sort(([a], [b]) => a.localeCompare(b)),
    items: data.orderItems.map((item) => [item.id, item.canonicalSalesUnitId]).sort(([a], [b]) => a.localeCompare(b)),
  });
  const run = (data) => {
    for (const storeId of storeIds) recalculateOrderMappingsForStore(data, storeId);
  };
  const start = performance.now();
  run(database);
  const elapsedMs = Math.round(performance.now() - start);
  const manualChanges = database.orderSourceSignatures.filter((signature) => manual.has(signature.id)
    && manual.get(signature.id) !== JSON.stringify(signature)).length;
  const changedMappedOrders = database.orderItems.filter((item) => beforeItems.get(item.id)
    && beforeItems.get(item.id) !== item.canonicalSalesUnitId).length;
  const newlyMappedOrders = database.orderItems.filter((item) => !beforeItems.get(item.id)
    && item.canonicalSalesUnitId).length;
  assert.equal(manualChanges, 0, 'Manual confirmations changed in the read-only simulation');
  assert.equal(changedMappedOrders, 0, 'Existing order mappings changed in the read-only simulation');

  const firstState = businessState(database);
  run(database);
  assert.equal(businessState(database) === firstState, true, 'Repeated recalculation changed mapping results');
  const reversed = structuredClone(original);
  reversed.canonicalSalesUnits.reverse();
  reversed.orderSourceSignatures.reverse();
  reversed.orderItems.reverse();
  run(reversed);
  assert.equal(businessState(reversed) === firstState, true, 'Input ordering changed mapping results');

  // Remove confirmations and historical mappings in memory to measure genuinely fresh group inference.
  // Historical manual decisions can contain exceptions; agreement is reported, not assumed as ground truth.
  const cold = createEmptyDatabase();
  cold.canonicalSalesUnits = structuredClone(original.canonicalSalesUnits);
  const contexts = new Map(storeIds.map((id) => [id, createOrderGroupContext(cold, id)]));
  const sampleBySignature = new Map();
  for (const item of original.orderItems) {
    if (!sampleBySignature.has(item.orderSourceSignatureId)) sampleBySignature.set(item.orderSourceSignatureId, item);
  }
  const expected = new Map();
  for (const signature of original.orderSourceSignatures) {
    if (!signature.confirmedAt || !signature.canonicalSalesUnitId) continue;
    const group = matchOrderGroup(contexts.get(signature.storeId) ?? [], signature);
    const sample = sampleBySignature.get(signature.id);
    if (!group || !group.familyUnitIds.has(signature.canonicalSalesUnitId) || !sample) continue;
    cold.orderSourceSignatures.push({ ...signature, confirmedAt: null, canonicalSalesUnitId: null, mappingStatus: 'UNMAPPED' });
    cold.orderItems.push({ ...sample, canonicalSalesUnitId: null });
    expected.set(signature.id, signature.canonicalSalesUnitId);
  }
  run(cold);
  const coldMapped = cold.orderSourceSignatures.filter((signature) => signature.canonicalSalesUnitId);
  const unitNames = new Map(cold.canonicalSalesUnits.map((unit) => [unit.id, unit.displayName]));
  const manualDifferences = coldMapped.filter((signature) => expected.get(signature.id) !== signature.canonicalSalesUnitId);
  console.log(JSON.stringify({
    readOnly: true,
    orders: database.orderItems.length,
    signatures: database.orderSourceSignatures.length,
    manualConfirmations: manual.size,
    manualChanges,
    changedMappedOrders,
    newlyMappedOrders,
    remainingUnmappedOrders: database.orderItems.filter((item) => !item.canonicalSalesUnitId).length,
    repeatedRecalculationStable: true,
    reversedInputStable: true,
    recalculationMs: elapsedMs,
    freshGroupInference: {
      signatures: expected.size,
      mapped: coldMapped.length,
      agreesWithHistoricalManual: coldMapped.filter((signature) => expected.get(signature.id) === signature.canonicalSalesUnitId).length,
      differsFromHistoricalManual: coldMapped.filter((signature) => expected.get(signature.id) !== signature.canonicalSalesUnitId).length,
      unresolved: expected.size - coldMapped.length,
      // Product labels and boolean markers only; never expose order/customer identifiers or free-form options.
      differences: manualDifferences.map((signature) => ({
        manualProduct: unitNames.get(expected.get(signature.id)),
        inferredProduct: unitNames.get(signature.canonicalSalesUnitId),
        optionMentionsFemale: /여성|여자/.test(signature.rawOptionInfoSnapshot ?? ''),
        optionMentionsMultiple: /\d+\s*[+＋]\s*\d+|[2-9]\s*개/.test(signature.rawOptionInfoSnapshot ?? ''),
      })),
    },
  }, null, 2));
}

main().catch((error) => {
  // Assertion messages contain no source records; database errors are limited to their code.
  console.error(error.code === 'ERR_ASSERTION' ? error.message : `Verification failed (${error.code ?? error.name})`);
  process.exitCode = 1;
});

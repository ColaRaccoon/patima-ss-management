#!/usr/bin/env node

import { createConnection } from "pg";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file
const envPath = join(__dirname, "../../.env");
let connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  try {
    const envContent = readFileSync(envPath, "utf-8");
    const match = envContent.match(/DATABASE_URL=(.+)/);
    if (match) {
      connectionString = match[1].trim();
    }
  } catch (err) {
    console.error("Could not read .env file:", err.message);
  }
}

if (!connectionString) {
  console.error("DATABASE_URL not found in environment or .env file");
  process.exit(1);
}

async function inspectSparseSignatures() {
  const client = new createConnection(connectionString);

  try {
    console.log("Connecting to database...");
    await client.connect();
    console.log("Connected successfully.\n");

    console.log("=== SPARSE SIGNATURE DIAGNOSIS ===\n");

    // 1. Count signatures with empty/null rawProductNameSnapshot
    const sparseResult = await client.query(`
      SELECT
        COUNT(*) as total_signatures,
        COUNT(CASE WHEN raw_product_name_snapshot IS NULL OR raw_product_name_snapshot = '' THEN 1 END) as empty_snapshot_count,
        ROUND(100.0 * COUNT(CASE WHEN raw_product_name_snapshot IS NULL OR raw_product_name_snapshot = '' THEN 1 END) / COUNT(*), 2) as empty_percentage
      FROM order_source_signatures;
    `);

    const {
      total_signatures,
      empty_snapshot_count,
      empty_percentage,
    } = sparseResult.rows[0];

    console.log(`1. Snapshot Coverage:`);
    console.log(`   Total signatures: ${total_signatures}`);
    console.log(`   Empty snapshots: ${empty_snapshot_count} (${empty_percentage}%)\n`);

    // 2. Fallback 1: Check rawProductName in order_items
    const fallback1Result = await client.query(`
      SELECT
        COUNT(DISTINCT oss.id) as signatures_with_fallback1
      FROM order_source_signatures oss
      WHERE (oss.raw_product_name_snapshot IS NULL OR oss.raw_product_name_snapshot = '')
        AND EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_source_signature_id = oss.id
            AND oi.raw_product_name IS NOT NULL
            AND oi.raw_product_name != ''
            AND length(oi.raw_product_name) > 2
            AND oi.raw_product_name NOT ~* '^(xs|s|m|l|xl|xxl|free|one|원사이즈|\\d+)$'
        );
    `);

    const fallback1Count = fallback1Result.rows[0].signatures_with_fallback1;
    const fallback1Percentage = (
      (parseInt(fallback1Count) / parseInt(empty_snapshot_count)) *
      100
    ).toFixed(2);

    console.log(`2. Fallback 1 (rawProductName in order_items):`);
    console.log(`   Recoverable signatures: ${fallback1Count} (${fallback1Percentage}% of empty)\n`);

    // 3. Fallback 2: Check products table
    const fallback2Result = await client.query(`
      SELECT
        COUNT(DISTINCT oss.id) as signatures_with_fallback2
      FROM order_source_signatures oss
      WHERE (oss.raw_product_name_snapshot IS NULL OR oss.raw_product_name_snapshot = '')
        AND NOT EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_source_signature_id = oss.id
            AND oi.raw_product_name IS NOT NULL
            AND oi.raw_product_name != ''
            AND length(oi.raw_product_name) > 2
            AND oi.raw_product_name NOT ~* '^(xs|s|m|l|xl|xxl|free|one|원사이즈|\\d+)$'
        )
        AND EXISTS (
          SELECT 1 FROM order_items oi
          JOIN products p ON p.external_product_id = oi.external_product_id AND p.store_id = oi.store_id
          WHERE oi.order_source_signature_id = oss.id
            AND p.product_name IS NOT NULL
            AND p.product_name != ''
            AND length(p.product_name) > 2
            AND p.product_name NOT ~* '^(xs|s|m|l|xl|xxl|free|one|원사이즈|\\d+)$'
        );
    `);

    const fallback2Count = fallback2Result.rows[0].signatures_with_fallback2;
    const fallback2Percentage = (
      (parseInt(fallback2Count) /
        (parseInt(empty_snapshot_count) - parseInt(fallback1Count))) *
      100
    ).toFixed(2);

    console.log(`3. Fallback 2 (products table):`);
    console.log(`   Recoverable signatures: ${fallback2Count} (${fallback2Percentage}% of remaining)\n`);

    // 4. Fallback 3: Check rawOptionInfo parsing
    const fallback3Result = await client.query(`
      SELECT
        COUNT(DISTINCT oss.id) as signatures_with_fallback3
      FROM order_source_signatures oss
      WHERE (oss.raw_product_name_snapshot IS NULL OR oss.raw_product_name_snapshot = '')
        AND NOT EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_source_signature_id = oss.id
            AND oi.raw_product_name IS NOT NULL
            AND oi.raw_product_name != ''
            AND length(oi.raw_product_name) > 2
            AND oi.raw_product_name NOT ~* '^(xs|s|m|l|xl|xxl|free|one|원사이즈|\\d+)$'
        )
        AND NOT EXISTS (
          SELECT 1 FROM order_items oi
          JOIN products p ON p.external_product_id = oi.external_product_id AND p.store_id = oi.store_id
          WHERE oi.order_source_signature_id = oss.id
            AND p.product_name IS NOT NULL
            AND p.product_name != ''
            AND length(p.product_name) > 2
            AND p.product_name NOT ~* '^(xs|s|m|l|xl|xxl|free|one|원사이즈|\\d+)$'
        )
        AND EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_source_signature_id = oss.id
            AND oi.raw_option_info SIMILAR TO '%\][^:]+:%'
        );
    `);

    const fallback3Count = fallback3Result.rows[0].signatures_with_fallback3;
    const remaining =
      parseInt(empty_snapshot_count) -
      parseInt(fallback1Count) -
      parseInt(fallback2Count);
    const fallback3Percentage = (
      (parseInt(fallback3Count) / remaining) *
      100
    ).toFixed(2);

    console.log(`4. Fallback 3 (rawOptionInfo parsing):`);
    console.log(`   Recoverable signatures: ${fallback3Count} (${fallback3Percentage}% of remaining)\n`);

    // 5. Summary
    const totalRecoverable =
      parseInt(fallback1Count) +
      parseInt(fallback2Count) +
      parseInt(fallback3Count);
    const totalRecoverablePercentage = (
      (totalRecoverable / parseInt(empty_snapshot_count)) *
      100
    ).toFixed(2);
    const unrecoverable =
      parseInt(empty_snapshot_count) - totalRecoverable;

    console.log(`=== SUMMARY ===`);
    console.log(`Empty snapshots total: ${empty_snapshot_count}`);
    console.log(`Total recoverable: ${totalRecoverable} (${totalRecoverablePercentage}%)`);
    console.log(`Unrecoverable (need API): ${unrecoverable}\n`);

    // 6. Pattern analysis (group shipping)
    const patternResult = await client.query(`
      SELECT
        COUNT(*) as group_shipping_count
      FROM order_source_signatures oss
      WHERE (oss.raw_product_name_snapshot IS NULL OR oss.raw_product_name_snapshot = '')
        AND oss.raw_option_info_snapshot LIKE '%[함께배송%';
    `);

    const groupShippingCount = patternResult.rows[0].group_shipping_count;
    console.log(`Pattern: Group shipping (함께배송) signatures: ${groupShippingCount}`);

    // 7. Sample data
    const sampleResult = await client.query(`
      SELECT
        oss.id,
        oss.source_signature,
        oss.raw_product_name_snapshot,
        oss.raw_option_info_snapshot,
        COUNT(oi.id) as item_count
      FROM order_source_signatures oss
      LEFT JOIN order_items oi ON oi.order_source_signature_id = oss.id
      WHERE (oss.raw_product_name_snapshot IS NULL OR oss.raw_product_name_snapshot = '')
      GROUP BY oss.id, oss.source_signature, oss.raw_product_name_snapshot, oss.raw_option_info_snapshot
      LIMIT 5;
    `);

    console.log(`\nSample empty signatures (first 5):`);
    sampleResult.rows.forEach((row, idx) => {
      console.log(`  ${idx + 1}. ${row.source_signature} || ${row.raw_option_info_snapshot} (${row.item_count} items)`);
    });

    console.log("\n✓ Diagnosis complete");
  } catch (err) {
    console.error("Error during diagnosis:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

inspectSparseSignatures();

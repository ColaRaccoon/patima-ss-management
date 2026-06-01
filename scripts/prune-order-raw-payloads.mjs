import {
  DEFAULT_ORDER_RAW_PAYLOAD_RETENTION_DAYS,
  createPgClient,
  getKstCutoffDate,
  getRetentionDays,
  parseArgs,
  printDryRunBanner,
  redactConnectionString,
  warnIfBackendIsRunning,
  withAdvisoryLock,
} from './db-maintenance-utils.mjs';

const args = parseArgs();
const dryRun = !args.flags.has('yes');
const days = getRetentionDays({
  args,
  envName: 'ORDER_RAW_PAYLOAD_RETENTION_DAYS',
  fallback: DEFAULT_ORDER_RAW_PAYLOAD_RETENTION_DAYS,
});
const cutoffDate = getKstCutoffDate(days);

const kstDateSql = (valueSql) => `
  CASE
    WHEN NULLIF(${valueSql}, '') IS NULL THEN NULL
    WHEN ${valueSql} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN ${valueSql}
    WHEN ${valueSql} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?$'
      THEN TO_CHAR((${valueSql})::timestamptz AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')
    WHEN ${valueSql} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN LEFT(${valueSql}, 10)
    ELSE NULL
  END
`;

const TABLES = [
  {
    name: 'orders',
    referenceDateSql: `
      COALESCE(
        ${kstDateSql("payload->>'paymentDatetime'")},
        ${kstDateSql("payload->>'orderDatetime'")},
        ${kstDateSql("payload->>'syncedAt'")}
      )
    `,
  },
  {
    name: 'order_items',
    referenceDateSql: `
      COALESCE(
        ${kstDateSql("payload->>'paymentDate'")},
        ${kstDateSql("payload->>'orderDate'")},
        ${kstDateSql("payload->>'createdAt'")}
      )
    `,
  },
];

const candidatePredicate = (referenceDateSql) => `
  payload ? 'rawPayload'
  AND payload->'rawPayload' IS DISTINCT FROM 'null'::jsonb
  AND (
    $2::int = 0
    OR (${referenceDateSql}) < $1
  )
`;

const summarizeTable = async (client, table) => {
  const predicate = candidatePredicate(table.referenceDateSql);
  const result = await client.query(
    `SELECT
       COUNT(*)::int AS row_count,
       COUNT(*) FILTER (
         WHERE payload ? 'rawPayload'
           AND payload->'rawPayload' IS DISTINCT FROM 'null'::jsonb
       )::int AS raw_payload_non_null_count,
       COUNT(*) FILTER (
         WHERE payload ? 'rawPayload'
           AND payload->'rawPayload' = 'null'::jsonb
       )::int AS raw_payload_null_count,
       COUNT(*) FILTER (WHERE ${predicate})::int AS prune_count
     FROM ${table.name}`,
    [cutoffDate, days],
  );
  return result.rows[0];
};

const pruneTable = async (client, table) => {
  const predicate = candidatePredicate(table.referenceDateSql);
  const result = await client.query(
    `UPDATE ${table.name}
     SET payload = jsonb_set(payload, '{rawPayload}', 'null'::jsonb, true),
         payload_hash = NULL,
         updated_at = NOW()
     WHERE ${predicate}`,
    [cutoffDate, days],
  );
  return result.rowCount;
};

const client = await createPgClient();
if (!client) {
  console.error('DATABASE_URL is missing. Current target would be file mode (apps/backend/data/database.json), but this prune script only updates PostgreSQL JSONB tables.');
  process.exit(1);
}

try {
  console.log('Order rawPayload prune');
  printDryRunBanner(dryRun);
  console.log(`Target: ${redactConnectionString(process.env.DATABASE_URL)}`);
  console.log(`Retention days: ${days}`);
  console.log(`KST cutoff date: ${cutoffDate}`);
  console.log('Rows are preserved; only payload.rawPayload is set to JSON null.');

  await warnIfBackendIsRunning();

  await withAdvisoryLock(client, 'patima:prune-order-raw-payloads', async () => {
    const summaries = [];
    for (const table of TABLES) {
      summaries.push([table.name, await summarizeTable(client, table)]);
    }

    console.log('\nSummary');
    for (const [tableName, summary] of summaries) {
      console.log(
        `  ${tableName}: rows=${summary.row_count}, rawPayload non-null=${summary.raw_payload_non_null_count}, rawPayload null=${summary.raw_payload_null_count}, prune candidates=${summary.prune_count}`,
      );
    }

    if (dryRun) {
      return;
    }

    await client.query('BEGIN');
    try {
      for (const table of TABLES) {
        const updated = await pruneTable(client, table);
        console.log(`  updated ${table.name}: ${updated}`);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}

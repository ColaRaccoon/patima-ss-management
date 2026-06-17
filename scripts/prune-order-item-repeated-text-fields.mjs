import {
  createPgClient,
  formatBytes,
  parseArgs,
  printDryRunBanner,
  redactConnectionString,
  warnIfBackendIsRunning,
  withAdvisoryLock,
} from './db-maintenance-utils.mjs';

const SAFE_FIELDS = [
  'normalizedProductName',
  'normalizedOptionInfo',
  'sourceSignature',
];

const FULL_FIELDS = [
  'rawProductName',
  'rawOptionInfo',
  ...SAFE_FIELDS,
];

const args = parseArgs();
const dryRun = !args.flags.has('yes');
const full = args.flags.has('full');
const fields = full ? FULL_FIELDS : SAFE_FIELDS;
const fieldCountAliases = fields.map((field) => ({
  field,
  alias: `${field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_count`,
}));

const removeExpression = (payloadSql = 'payload') =>
  fields.reduce((expression, field) => `${expression} - '${field}'`, payloadSql);

const fieldCountSelectSql = fieldCountAliases
  .map(({ field, alias }) => `COUNT(*) FILTER (WHERE payload ? '${field}')::int AS ${alias}`)
  .join(',\n       ');

const summarize = async (client) => {
  const result = await client.query(
    `SELECT
       COUNT(*)::int AS row_count,
       COUNT(*) FILTER (WHERE payload ?| $1::text[])::int AS candidate_count,
       COALESCE(SUM(pg_column_size(payload)), 0)::bigint AS before_bytes,
       COALESCE(SUM(pg_column_size(${removeExpression()})), 0)::bigint AS after_bytes,
       COALESCE(SUM(pg_column_size(payload) - pg_column_size(${removeExpression()})), 0)::bigint AS estimated_saved_bytes,
       ${fieldCountSelectSql}
     FROM order_items`,
    [fields],
  );
  return result.rows[0];
};

const prune = async (client) => {
  const result = await client.query(
    `UPDATE order_items
     SET payload = ${removeExpression()},
         payload_hash = NULL,
         updated_at = NOW()
     WHERE payload ?| $1::text[]`,
    [fields],
  );
  return result.rowCount;
};

const client = await createPgClient();
if (!client) {
  console.error('DATABASE_URL is missing. This prune script only updates PostgreSQL JSONB order_items payloads.');
  process.exit(1);
}

try {
  console.log('Order item repeated text field prune');
  printDryRunBanner(dryRun);
  console.log(`Target: ${redactConnectionString(process.env.DATABASE_URL)}`);
  console.log(`Mode: ${full ? 'full (raw + normalized + sourceSignature)' : 'safe (normalized + sourceSignature)'}`);
  console.log(`Fields: ${fields.join(', ')}`);
  console.log('Rows are preserved; only selected keys are removed from order_items.payload.');

  await warnIfBackendIsRunning();

  await withAdvisoryLock(client, 'patima:prune-order-item-repeated-text-fields', async () => {
    const summary = await summarize(client);

    console.log('\nSummary');
    console.log(`  rows: ${summary.row_count}`);
    console.log(`  prune candidates: ${summary.candidate_count}`);
    console.log(`  before payload bytes: ${formatBytes(summary.before_bytes)}`);
    console.log(`  after payload bytes: ${formatBytes(summary.after_bytes)}`);
    console.log(`  estimated saved bytes: ${formatBytes(summary.estimated_saved_bytes)}`);
    fieldCountAliases.forEach(({ field, alias }) => {
      console.log(`  ${field}: ${summary[alias] ?? 0}`);
    });

    if (dryRun) {
      return;
    }

    await client.query('BEGIN');
    try {
      const updated = await prune(client);
      await client.query('COMMIT');
      console.log(`\nUpdated order_items rows: ${updated}`);
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

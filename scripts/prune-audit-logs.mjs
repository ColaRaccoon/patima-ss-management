import path from 'node:path';
import {
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
  createPgClient,
  ensureArchiveDir,
  getKstCutoffDate,
  getRetentionDays,
  parseArgs,
  printDryRunBanner,
  redactConnectionString,
  warnIfBackendIsRunning,
  withAdvisoryLock,
  writeJsonlArchive,
} from './db-maintenance-utils.mjs';

const args = parseArgs();
const dryRun = !args.flags.has('yes');
const days = getRetentionDays({
  args,
  envName: 'AUDIT_LOG_RETENTION_DAYS',
  fallback: DEFAULT_AUDIT_LOG_RETENTION_DAYS,
});
const cutoffDate = getKstCutoffDate(days);

const createdDateSql = `
  COALESCE(
    NULLIF(LEFT(payload->>'createdAt', 10), ''),
    NULLIF(LEFT(updated_at::text, 10), '')
  )
`;

const targetPredicate = `(${createdDateSql}) < $1`;

const archiveName = () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `audit_logs_before_${cutoffDate}_${timestamp}.jsonl`;
};

const client = await createPgClient();
if (!client) {
  console.error('DATABASE_URL is missing. Current target would be file mode (apps/backend/data/database.json), but this audit log archive/prune script only updates PostgreSQL JSONB tables.');
  process.exit(1);
}

try {
  console.log('Audit log archive/prune');
  printDryRunBanner(dryRun);
  console.log(`Target: ${redactConnectionString(process.env.DATABASE_URL)}`);
  console.log(`Retention days: ${days}`);
  console.log(`KST cutoff date: ${cutoffDate}`);
  console.log('Old audit logs are archived to JSONL before deletion when --yes is used.');

  await warnIfBackendIsRunning();

  await withAdvisoryLock(client, 'patima:prune-audit-logs', async () => {
    const summary = await client.query(
      `SELECT
         COUNT(*)::int AS row_count,
         COUNT(*) FILTER (WHERE ${targetPredicate})::int AS prune_count,
         MIN(${createdDateSql}) FILTER (WHERE ${targetPredicate}) AS oldest_target_date,
         MAX(${createdDateSql}) FILTER (WHERE ${targetPredicate}) AS newest_target_date,
         ROUND(AVG(pg_column_size(payload)))::int AS average_payload_bytes
       FROM audit_logs`,
      [cutoffDate],
    );

    const row = summary.rows[0];
    console.log('\nSummary');
    console.log(`  audit_logs rows=${row.row_count}`);
    console.log(`  archive/delete candidates=${row.prune_count}`);
    console.log(`  target date range=${row.oldest_target_date ?? '-'}..${row.newest_target_date ?? '-'}`);
    console.log(`  average payload bytes=${row.average_payload_bytes ?? 0}`);

    if (dryRun || Number(row.prune_count) === 0) {
      return;
    }

    const targetRows = await client.query(
      `SELECT id, payload, payload_hash, updated_at
       FROM audit_logs
       WHERE ${targetPredicate}
       ORDER BY ${createdDateSql}, id`,
      [cutoffDate],
    );

    const archiveDir = ensureArchiveDir();
    const archivePath = path.join(archiveDir, archiveName());
    writeJsonlArchive(archivePath, targetRows.rows);

    await client.query('BEGIN');
    try {
      const deleted = await client.query(
        `DELETE FROM audit_logs
         WHERE id = ANY($1::text[])`,
        [targetRows.rows.map((item) => item.id)],
      );
      await client.query('COMMIT');
      console.log(`  archive file=${archivePath}`);
      console.log(`  deleted audit_logs=${deleted.rowCount}`);
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


import path from 'node:path';
import {
  DEFAULT_OPERATION_RETENTION_DAYS,
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
const pruneFailed = args.flags.has('prune-failed');
const keepFailed = args.flags.has('keep-failed');
if (pruneFailed && keepFailed) {
  console.error('ERROR: Use either --prune-failed or --keep-failed, not both.');
  process.exit(1);
}

const days = getRetentionDays({
  args,
  envName: 'OPERATION_RETENTION_DAYS',
  fallback: DEFAULT_OPERATION_RETENTION_DAYS,
});
const cutoffDate = getKstCutoffDate(days);

const operationDateSql = `
  COALESCE(
    NULLIF(LEFT(payload->>'finishedAt', 10), ''),
    NULLIF(LEFT(payload->>'createdAt', 10), ''),
    NULLIF(LEFT(payload->>'cutoffAt', 10), ''),
    NULLIF(LEFT(updated_at::text, 10), '')
  )
`;

const targetPredicate = `
  (${operationDateSql}) < $1
  AND payload->>'status' NOT IN ('QUEUED', 'RUNNING')
  AND (
    payload->>'status' = 'SUCCEEDED'
    OR ($2::boolean IS TRUE AND payload->>'status' = 'FAILED')
  )
`;

const archiveName = () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `operations_before_${cutoffDate}_${timestamp}.jsonl`;
};

const getProtectedCandidateIds = (allRows, candidateRows) => {
  const candidateIds = new Set(candidateRows.map((row) => row.id));
  const rowsById = new Map(allRows.map((row) => [row.id, row]));
  const protectedIds = new Set();

  const protectCandidateAncestors = (startId) => {
    let currentId = startId;
    while (currentId && candidateIds.has(currentId) && !protectedIds.has(currentId)) {
      protectedIds.add(currentId);
      currentId = rowsById.get(currentId)?.payload?.retryOfOperationId;
    }
  };

  for (const row of allRows) {
    if (candidateIds.has(row.id)) {
      continue;
    }
    const retryOf = row.payload?.retryOfOperationId;
    protectCandidateAncestors(retryOf);
  }

  return protectedIds;
};

const client = await createPgClient();
if (!client) {
  console.error('DATABASE_URL is missing. Current target would be file mode (apps/backend/data/database.json), but this operation archive/prune script only updates PostgreSQL JSONB tables.');
  process.exit(1);
}

try {
  console.log('Operation archive/prune');
  printDryRunBanner(dryRun);
  console.log(`Target: ${redactConnectionString(process.env.DATABASE_URL)}`);
  console.log(`Retention days: ${days}`);
  console.log(`KST cutoff date: ${cutoffDate}`);
  console.log(`Failed operations: ${pruneFailed ? 'included because --prune-failed was set' : 'kept'}`);
  console.log('QUEUED and RUNNING operations are always kept.');

  await warnIfBackendIsRunning();

  await withAdvisoryLock(client, 'patima:prune-operations', async () => {
    const statusSummary = await client.query(
      `SELECT COALESCE(payload->>'status', 'UNKNOWN') AS status, COUNT(*)::int AS count
       FROM operations
       GROUP BY 1
       ORDER BY 1`,
    );
    const candidateResult = await client.query(
      `SELECT id, payload, payload_hash, updated_at
       FROM operations
       WHERE ${targetPredicate}
       ORDER BY ${operationDateSql}, id`,
      [cutoffDate, pruneFailed],
    );
    const allRows = await client.query('SELECT id, payload FROM operations');
    const protectedIds = getProtectedCandidateIds(allRows.rows, candidateResult.rows);
    const targetRows = candidateResult.rows.filter((row) => !protectedIds.has(row.id));

    console.log('\nSummary');
    for (const row of statusSummary.rows) {
      console.log(`  status ${row.status}: ${row.count}`);
    }
    console.log(`  raw candidates=${candidateResult.rows.length}`);
    console.log(`  protected by retry chain=${protectedIds.size}`);
    console.log(`  archive/delete candidates=${targetRows.length}`);

    if (dryRun || targetRows.length === 0) {
      return;
    }

    const archiveDir = ensureArchiveDir();
    const archivePath = path.join(archiveDir, archiveName());
    writeJsonlArchive(archivePath, targetRows);

    await client.query('BEGIN');
    try {
      const deleted = await client.query(
        `DELETE FROM operations
         WHERE id = ANY($1::text[])`,
        [targetRows.map((item) => item.id)],
      );
      await client.query('COMMIT');
      console.log(`  archive file=${archivePath}`);
      console.log(`  deleted operations=${deleted.rowCount}`);
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

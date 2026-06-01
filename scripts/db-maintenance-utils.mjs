import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const SNAPSHOT_SCHEMA_VERSION = 3;
export const SNAPSHOT_FORMAT = 'jsonb-payload-v2';
export const DEFAULT_ORDER_RAW_PAYLOAD_RETENTION_DAYS = 90;
export const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 180;
export const DEFAULT_OPERATION_RETENTION_DAYS = 90;
export const DEFAULT_ARCHIVE_DIR = './backups/archive';
export const KST_TIME_ZONE = 'Asia/Seoul';

export const FULL_SYNC_TABLES = [
  'stores',
  'commerce_api_credentials',
  'products',
  'canonical_sales_units',
  'order_source_signatures',
  'orders',
  'order_items',
  'campaign_sales_unit_mappings',
  'ad_campaign_signatures',
  'ad_excel_uploads',
  'ad_upload_preview_rows',
  'ad_campaign_daily_costs',
  'sales_unit_cost_settings',
  'sales_unit_cost_snapshots',
  'sales_unit_cost_snapshot_entries',
  'daily_fake_purchases',
  'daily_sales_unit_profits',
  'daily_store_summaries',
  'operations',
  'audit_logs',
];

export const DATABASE_SHAPE_KEYS = [
  ['stores', 'stores'],
  ['commerceCredentials', 'commerce_api_credentials'],
  ['products', 'products'],
  ['canonicalSalesUnits', 'canonical_sales_units'],
  ['orderSourceSignatures', 'order_source_signatures'],
  ['orders', 'orders'],
  ['orderItems', 'order_items'],
  ['campaignMappings', 'campaign_sales_unit_mappings'],
  ['adCampaignSignatures', 'ad_campaign_signatures'],
  ['adExcelUploads', 'ad_excel_uploads'],
  ['adUploadPreviewRows', 'ad_upload_preview_rows'],
  ['adCampaignDailyCosts', 'ad_campaign_daily_costs'],
  ['salesUnitCostSettings', 'sales_unit_cost_settings'],
  ['salesUnitCostSnapshots', 'sales_unit_cost_snapshots'],
  ['salesUnitCostSnapshotEntries', 'sales_unit_cost_snapshot_entries'],
  ['dailyFakePurchases', 'daily_fake_purchases'],
  ['dailySalesUnitProfits', 'daily_sales_unit_profits'],
  ['dailyStoreSummaries', 'daily_store_summaries'],
  ['operations', 'operations'],
  ['auditLogs', 'audit_logs'],
];

export const parseArgs = (argv = process.argv.slice(2)) => {
  const flags = new Set();
  const values = new Map();
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const eqIndex = token.indexOf('=');
    if (eqIndex !== -1) {
      values.set(token.slice(2, eqIndex), token.slice(eqIndex + 1));
      continue;
    }

    const name = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      values.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }

  return { flags, values, positionals };
};

export const parseNonNegativeInt = (value, fallback, label) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }

  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${label} must be a non-negative integer: ${value}`);
  }

  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} is too large: ${value}`);
  }
  return parsed;
};

export const getRetentionDays = ({ args, optionName = 'days', envName, fallback }) => {
  if (args.values.has(optionName)) {
    return parseNonNegativeInt(args.values.get(optionName), fallback, `--${optionName}`);
  }
  return parseNonNegativeInt(process.env[envName], fallback, envName);
};

const formatKstDate = (date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: KST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

const addDays = (dateString, days) => {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

export const getKstCutoffDate = (days, now = new Date()) => addDays(formatKstDate(now), -days);

export const redactConnectionString = (connectionString) =>
  connectionString.replace(/:[^:@/]*@/, ':***@');

export const createPgClient = async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return null;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
};

export const quoteIdentifier = (identifier) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Unsupported table identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};

export const toStableJsonValue = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => toStableJsonValue(item) ?? null);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((stable, key) => {
      const normalized = toStableJsonValue(value[key]);
      if (normalized !== undefined) stable[key] = normalized;
      return stable;
    }, {});
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  return value;
};

export const stableStringify = (value) => JSON.stringify(toStableJsonValue(value)) ?? 'null';

export const hashPayload = (payload) =>
  crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');

export const getExistingPayloadTables = async (client) => {
  const result = await client.query(`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema='public' AND column_name='payload'
    ORDER BY table_name
  `);
  return result.rows.map((row) => row.table_name);
};

export const getExistingPublicTables = async (client) => {
  const result = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema='public'
    ORDER BY table_name
  `);
  return result.rows.map((row) => row.table_name);
};

export const warnIfBackendIsRunning = async () => {
  const probe = await fetch('http://localhost:4000/api/v1/stores', {
    signal: AbortSignal.timeout(1500),
  }).catch(() => null);
  if (probe && probe.ok) {
    console.warn('WARNING: Backend on localhost:4000 responded. Stop it before --yes prune/import runs.');
    return true;
  }
  return false;
};

export const withAdvisoryLock = async (client, lockName, fn) => {
  const lockResult = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockName]);
  if (!lockResult.rows[0]?.locked) {
    throw new Error(`Could not acquire PostgreSQL advisory lock: ${lockName}`);
  }

  try {
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]).catch(() => undefined);
  }
};

export const getArchiveDir = () => path.resolve(process.env.DB_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR);

export const ensureArchiveDir = () => {
  const archiveDir = getArchiveDir();
  fs.mkdirSync(archiveDir, { recursive: true });
  return archiveDir;
};

export const writeJsonlArchive = (archivePath, rows) => {
  const tempPath = `${archivePath}.tmp-${process.pid}-${Date.now()}`;
  const content = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, archivePath);
  return archivePath;
};

export const listBackupFiles = (root = path.resolve('backups')) => {
  if (!fs.existsSync(root)) {
    return [];
  }

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const stat = fs.statSync(fullPath);
      files.push({
        path: fullPath,
        relativePath: path.relative(process.cwd(), fullPath),
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  };
  walk(root);
  return files.sort((left, right) => right.bytes - left.bytes);
};

export const formatBytes = (bytes) => `${Number(bytes || 0).toLocaleString()} bytes`;

export const printDryRunBanner = (isDryRun) => {
  console.log(isDryRun ? 'Mode: dry-run (no changes; add --yes to execute)' : 'Mode: EXECUTE (--yes)');
};


# Patima Naver SS

Smart Store profit management MVP for order, mapping, ad cost, and profit tracking.

## Workspaces

- `apps/frontend`: Next.js frontend
- `apps/backend`: Nest-style API backend
- `packages/shared`: shared types and normalization helpers

## Run

```bash
npm install
npm run dev:backend
npm run dev:frontend
```

## Environment

The backend now supports three layers for Naver Commerce integration:

- PostgreSQL persistence through `DATABASE_URL`
- Environment-driven Naver solution credentials through `NAVER_*`
- Store + credential bootstrap on startup when all required `NAVER_*` values exist
- Order raw payload retention through `ORDER_RAW_PAYLOAD_RETENTION_DAYS` (default `0`)

Required Naver values:

```env
NAVER_SOLUTION_ID=
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
NAVER_ACCOUNT_UID=
NAVER_CHANNEL_NO=
NAVER_CALLBACK_URL=
```

Optional storage controls:

```env
ORDER_RAW_PAYLOAD_RETENTION_DAYS=0
AUDIT_LOG_RETENTION_DAYS=180
OPERATION_RETENTION_DAYS=90
DB_ARCHIVE_DIR=./backups/archive
```

`ORDER_RAW_PAYLOAD_RETENTION_DAYS` defaults to `0`, so new order syncs store
`OrderRecord.rawPayload` and `OrderItem.rawPayload` as `null`. Set a positive integer, such as
`30` or `90`, only when raw Naver order JSON needs to be retained temporarily for recent KST
order/payment dates. Invalid values fall back to `0`.

Maintenance scripts are dry-run by default:

```bash
node scripts/report-db-size.mjs
node scripts/prune-order-raw-payloads.mjs --days 0
node scripts/prune-audit-logs.mjs --days 180
node scripts/prune-operations.mjs --days 90 --keep-failed
```

Add `--yes` only after creating a fresh snapshot and stopping the backend.

## Current behavior

- If `DATABASE_URL` exists, PostgreSQL is the primary storage provider.
- If `DATABASE_URL` is missing, the backend falls back to `apps/backend/data/database.json`.
- Runtime PostgreSQL storage is one row per record in `id + payload JSONB + payload_hash + updated_at` tables. The backend still loads a `DatabaseShape` memory snapshot on startup for shared business logic and file-mode parity.
- General write APIs use committed persistence: a successful PostgreSQL write response means the snapshot transaction committed, and file fallback writes through a temporary file before rename.
- Manual order/ad mapping hot paths now bypass full `DatabaseShape` snapshot persistence in PostgreSQL mode. They lock and update only selected signature/row payloads, update `payload_hash`, refresh the same rows in memory, and replace only affected daily profit summary dates.
- PostgreSQL runtime snapshot persistence keeps the JSONB payload tables but writes changed snapshots with row-level upsert/delete and `payload_hash`; full PC sync remains `scripts/db-export.mjs` / `scripts/db-import.mjs`.
- DB maintenance scripts cover size reporting, manual order raw payload pruning, audit log archiving, operation archiving, and restore rehearsal. See `scripts/README.md` and `DB_RESTORE_RUNBOOK.md`.
- If matching `NAVER_*` values exist, the backend bootstraps a Smart Store record and seller credential automatically.
- Credential test now issues a real SELLER token and checks seller account/channel endpoints.
- Order sync now prefers live Naver Commerce API calls.
- Order sync stores order/order-item `rawPayload` only when `ORDER_RAW_PAYLOAD_RETENTION_DAYS` is greater than `0`; pruning preserves order rows, item rows, option codes, fees, delivery fees, sales amounts, and mapping fields.
- If no live Naver credential is available for the store, order sync falls back to the existing mock generator.
- If live Naver sync is configured but the API call fails, the sync is marked as failed instead of silently using mock data.

The live sync path uses:

- `POST /v1/oauth2/token`
- `GET /v1/pay-order/seller/product-orders/last-changed-statuses`
- `POST /v1/pay-order/seller/product-orders/query`
- `GET /v1/seller/account`
- `GET /v1/seller/channels`

## Verify

```bash
npm run lint
npm run test
npm run build
```

## Docker

`docker-compose.yml` is included for local PostgreSQL startup, but Docker execution still depends on the local machine environment.

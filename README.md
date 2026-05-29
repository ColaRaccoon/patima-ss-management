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
- Order raw payload retention through `ORDER_RAW_PAYLOAD_RETENTION_DAYS` (default `90`)

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
ORDER_RAW_PAYLOAD_RETENTION_DAYS=90
```

`ORDER_RAW_PAYLOAD_RETENTION_DAYS` keeps `OrderRecord.rawPayload` and `OrderItem.rawPayload`
only for recent KST order/payment dates. It must be a non-negative integer; invalid values fall
back to `90`. Set it to `0` to avoid storing new order raw payloads and prune existing payloads
for the synced store.

## Current behavior

- If `DATABASE_URL` exists, PostgreSQL is the primary storage provider.
- If `DATABASE_URL` is missing, the backend falls back to `apps/backend/data/database.json`.
- Write APIs use committed persistence for the main mutation paths: a successful PostgreSQL write response means the snapshot transaction committed, and file fallback writes through a temporary file before rename.
- PostgreSQL runtime persistence keeps the `id + payload JSONB` tables but writes changed snapshots with row-level upsert/delete and `payload_hash`; full PC sync remains `scripts/db-export.mjs` / `scripts/db-import.mjs`.
- If matching `NAVER_*` values exist, the backend bootstraps a Smart Store record and seller credential automatically.
- Credential test now issues a real SELLER token and checks seller account/channel endpoints.
- Order sync now prefers live Naver Commerce API calls.
- Order sync prunes only expired order/order-item `rawPayload` values for the synced store; order rows, item rows, option codes, fees, delivery fees, sales amounts, and mapping fields are preserved.
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

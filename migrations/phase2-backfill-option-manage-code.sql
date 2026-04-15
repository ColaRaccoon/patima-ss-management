-- Backfill optionManageCode from rawPayload to top-level payload field
-- This script extracts optionManageCode from the nested rawPayload structure
-- and sets it at the top level for all existing order items that don't already have it

UPDATE order_items
SET payload = jsonb_set(
  payload, '{optionManageCode}',
  COALESCE(
    payload->'rawPayload'->'detail'->'productOrder'->'optionManageCode',
    'null'::jsonb
  )
)
WHERE payload->>'optionManageCode' IS NULL;

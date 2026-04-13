-- Phase 1: Backfill optionCode from rawPayload into order_items
-- This migration extracts optionCode from the nested rawPayload structure
-- and sets it directly on each order item for easier access

-- Note: 'null'::jsonb is JSON null (not the string "null").
-- jsonb_set with SQL NULL would null out the entire payload, so we use JSON null.
UPDATE order_items
SET payload = jsonb_set(
  payload, '{optionCode}',
  COALESCE(
    payload->'rawPayload'->'detail'->'productOrder'->'optionCode',
    'null'::jsonb
  )
)
WHERE payload->>'optionCode' IS NULL;

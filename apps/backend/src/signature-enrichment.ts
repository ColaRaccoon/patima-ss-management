import { DatabaseShape, OrderSourceSignature, OrderItem } from "@patima/shared";

export type FallbackProductNameSource =
  | "snapshot"
  | "orderItem"
  | "optionInfo"
  | "product"
  | "commerceApi"
  | null;

export interface EnrichedSignatureInfo {
  fallbackProductName: string | null;
  fallbackProductNameSource: FallbackProductNameSource;
}

/**
 * A-0: Determines if a string is a "meaningful" product name.
 * Returns false if:
 * - empty/null/whitespace only
 * - length <= 2
 * - matches size/option pattern (case-insensitive)
 * - is contained within the contextOptionInfo (sign of value leakage from option field)
 */
export function isMeaningfulName(
  value: string | null | undefined,
  contextOptionInfo?: string | null,
): boolean {
  if (!value) {
    return false;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length <= 2) {
    return false;
  }

  // Size/option pattern: xs, s, m, l, xl, xxl, free, one, 원사이즈, or digits
  if (/^(xs|s|m|l|xl|xxl|free|one|원사이즈|\d+)$/i.test(trimmed)) {
    return false;
  }

  // Check if value is contained within contextOptionInfo (indicates value leaked into product name)
  if (contextOptionInfo) {
    const optionLower = contextOptionInfo.toLowerCase();
    const valueLower = trimmed.toLowerCase();
    // If the trimmed value appears in the option info, it's likely an option value, not a product name
    if (optionLower.includes(valueLower)) {
      return false;
    }
  }

  return true;
}

/**
 * A-1-2: Extracts product name from rawOptionInfo using regex pattern.
 * Supports two patterns:
 * 1. With tag: "[함께배송⭐추가할인]러닝깔창: L" -> "러닝깔창"
 * 2. Without tag: "무릎보호대: XL" -> "무릎보호대"
 *
 * First tries to match "]<name>:" (tagged pattern), then falls back to "^<name>:" (plain pattern).
 */
export function extractNameFromOptionInfo(optionInfo: string): string | null {
  if (!optionInfo) {
    return null;
  }

  // Try pattern 1: "]..:" - match text after ] and before :
  let match = optionInfo.match(/\]\s*([^:]+?)\s*:/);

  // Fallback to pattern 2: "^..:" - match text at start before :
  if (!match || !match[1]) {
    match = optionInfo.match(/^([^:]+?)\s*:/);
  }

  if (!match || !match[1]) {
    return null;
  }

  const extracted = match[1].trim();
  return extracted.length > 0 ? extracted : null;
}

export interface EnrichmentContext {
  // Map of signatureId -> related orderItems
  signatureItemsMap?: Map<string, OrderItem[]>;
  // Map of (externalProductId + storeId) -> product info { productName }
  productsByIdMap?: Map<string, { productName: string | null }>;
}

/**
 * Main enrichment function: Applies fallback chain to recover meaningful product name.
 * Returns { fallbackProductName, source } where source indicates which step succeeded.
 *
 * Optionally accepts precomputed context to avoid N+1 queries.
 * If context is not provided, falls back to direct database queries.
 */
export async function enrichSignatureDisplayName(
  database: DatabaseShape,
  signature: OrderSourceSignature,
  context?: EnrichmentContext,
): Promise<EnrichedSignatureInfo> {
  // Step 1: Check if snapshot itself is meaningful
  if (isMeaningfulName(signature.rawProductNameSnapshot, signature.rawOptionInfoSnapshot)) {
    return {
      fallbackProductName: signature.rawProductNameSnapshot,
      fallbackProductNameSource: "snapshot",
    };
  }

  // Gather related order items for this signature
  let relatedItems: OrderItem[];
  if (context?.signatureItemsMap) {
    relatedItems = context.signatureItemsMap.get(signature.id) ?? [];
  } else {
    relatedItems = database.orderItems.filter(
      (item) => item.orderSourceSignatureId === signature.id,
    );
  }

  // Step 2: Check order_items rawProductName
  for (const item of relatedItems) {
    if (isMeaningfulName(item.rawProductName, item.rawOptionInfo)) {
      return {
        fallbackProductName: item.rawProductName,
        fallbackProductNameSource: "orderItem",
      };
    }
  }

  // Step 3: Parse rawOptionInfo (signature level first)
  const extractedFromSignature =
    extractNameFromOptionInfo(signature.rawOptionInfoSnapshot || "");
  if (extractedFromSignature && isMeaningfulName(extractedFromSignature)) {
    return {
      fallbackProductName: extractedFromSignature,
      fallbackProductNameSource: "optionInfo",
    };
  }

  // Also try order_items rawOptionInfo
  for (const item of relatedItems) {
    const extracted = extractNameFromOptionInfo(item.rawOptionInfo || "");
    if (extracted && isMeaningfulName(extracted)) {
      return {
        fallbackProductName: extracted,
        fallbackProductNameSource: "optionInfo",
      };
    }
  }

  // Step 4: Check products table via externalProductId
  for (const item of relatedItems) {
    if (item.externalProductId) {
      let product: { productName: string | null } | undefined;

      if (context?.productsByIdMap) {
        const key = `${item.externalProductId}:${signature.storeId}`;
        product = context.productsByIdMap.get(key);
      } else {
        const found = database.products.find(
          (p) =>
            p.externalProductId === item.externalProductId &&
            p.storeId === signature.storeId,
        );
        product = found ? { productName: found.productName } : undefined;
      }

      if (product && isMeaningfulName(product.productName)) {
        return {
          fallbackProductName: product.productName,
          fallbackProductNameSource: "product",
        };
      }
    }
  }

  // Step 5: Commerce API (stub for now - future implementation)
  // Would call external API if enabled, then return source: 'commerceApi'
  // For now, just continue to fallback null

  // All fallbacks exhausted
  return {
    fallbackProductName: null,
    fallbackProductNameSource: null,
  };
}

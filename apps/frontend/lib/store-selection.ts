import type { StoreListItem } from "@/lib/api/types";

export const STORE_ID_QUERY_KEY = "storeId";

type SearchQuery = string | URLSearchParams | { toString: () => string } | null | undefined;

export const readSearchParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export const pickPrimaryStore = (stores: StoreListItem[]) =>
  stores.find((store) => store.isPrimary) ?? stores[0] ?? null;

export const resolveSelectedStore = (
  stores: StoreListItem[],
  requestedStoreId?: string | null,
) => {
  const normalizedStoreId = requestedStoreId?.trim();
  const requestedStore = normalizedStoreId
    ? stores.find((store) => store.id === normalizedStoreId)
    : null;

  return requestedStore ?? pickPrimaryStore(stores);
};

export const buildHrefWithStore = (
  pathname: string,
  currentQuery: SearchQuery,
  storeId: string | null | undefined,
) => {
  const params = new URLSearchParams(
    typeof currentQuery === "string" ? currentQuery : currentQuery?.toString(),
  );

  if (storeId) {
    params.set(STORE_ID_QUERY_KEY, storeId);
  } else {
    params.delete(STORE_ID_QUERY_KEY);
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
};

export const buildStoreSwitchHref = (
  pathname: string,
  currentQuery: SearchQuery,
  storeId: string | null | undefined,
) => {
  const params = new URLSearchParams(
    typeof currentQuery === "string" ? currentQuery : currentQuery?.toString(),
  );
  // Keep the user's date/search filters, but start the new store at its first
  // page and do not reopen a job or detail belonging to the previous store.
  for (const key of [
    "page", "orderPage", "signaturePage", "adPage", "batchId", "operationId",
    "salesUnitId", "canonicalSalesUnitId", "signatureId", "uploadId",
  ]) {
    params.delete(key);
  }
  return buildHrefWithStore(pathname, params, storeId);
};

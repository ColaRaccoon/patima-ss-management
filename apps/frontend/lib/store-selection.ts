import type { StoreListItem } from "@/lib/api/types";

export const STORE_ID_QUERY_KEY = "storeId";

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
  currentQuery:
    | string
    | URLSearchParams
    | { toString: () => string }
    | null
    | undefined,
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

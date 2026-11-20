import { MappingsView } from "@/components/mappings/mappings-view";
import { getMappingsPageData, normalizeMappingStatus } from "@/lib/api/services";
import { readSearchParam } from "@/lib/store-selection";

type SearchParams = Record<string, string | string[] | undefined>;

const DEFAULT_PAGE_SIZE = 100;
const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parsePageSize(value: string | undefined) {
  const parsed = parsePositiveInt(value, DEFAULT_PAGE_SIZE);
  return PAGE_SIZE_OPTIONS.some((option) => option === parsed) ? parsed : DEFAULT_PAGE_SIZE;
}

export default async function MappingsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const data = await getMappingsPageData({
    storeId: readSearchParam(resolvedSearchParams.storeId),
    order: {
      page: parsePositiveInt(readSearchParam(resolvedSearchParams.orderPage), 1),
      pageSize: parsePageSize(readSearchParam(resolvedSearchParams.orderPageSize)),
      mappingStatus: normalizeMappingStatus(readSearchParam(resolvedSearchParams.orderStatus)),
      q: readSearchParam(resolvedSearchParams.orderQ) ?? "",
    },
    ad: {
      page: parsePositiveInt(readSearchParam(resolvedSearchParams.adPage), 1),
      pageSize: parsePageSize(readSearchParam(resolvedSearchParams.adPageSize)),
      mappingStatus: normalizeMappingStatus(readSearchParam(resolvedSearchParams.adStatus)),
      excludeZeroCost: readSearchParam(resolvedSearchParams.adShowZero) !== "1",
      q: readSearchParam(resolvedSearchParams.adQ) ?? "",
    },
  });
  return <MappingsView key={data.primaryStore?.id} data={data} />;
}

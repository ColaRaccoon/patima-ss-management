import { CostsView } from "@/components/costs/costs-view";
import { getCostsPageData } from "@/lib/api/services";
import { readSearchParam } from "@/lib/store-selection";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function CostsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const data = await getCostsPageData({
    storeId: readSearchParam(resolvedSearchParams.storeId),
  });
  return <CostsView data={data} />;
}

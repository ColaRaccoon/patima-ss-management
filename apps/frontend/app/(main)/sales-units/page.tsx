import { SalesUnitsView } from "@/components/sales-units/sales-units-view";
import { getSalesUnitsPageData } from "@/lib/api/services";
import { readSearchParam } from "@/lib/store-selection";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function SalesUnitsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const data = await getSalesUnitsPageData({
    storeId: readSearchParam(resolvedSearchParams.storeId),
  });

  return <SalesUnitsView data={data} />;
}

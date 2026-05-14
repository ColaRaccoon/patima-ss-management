import { OperationsView } from "@/components/operations/operations-view";
import { getOperationsPageData } from "@/lib/api/services";
import { readSearchParam } from "@/lib/store-selection";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function OperationsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const data = await getOperationsPageData({
    storeId: readSearchParam(resolvedSearchParams.storeId),
  });
  return <OperationsView data={data} />;
}

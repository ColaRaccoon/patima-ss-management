import { DashboardView } from "@/components/dashboard/dashboard-view";
import { getDashboardPageData } from "@/lib/api/services";
import { readSearchParam } from "@/lib/store-selection";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const data = await getDashboardPageData({
    storeId: readSearchParam(resolvedSearchParams.storeId),
  });

  return <DashboardView data={data} />;
}

import { MappingsView } from "@/components/mappings/mappings-view";
import { getMappingsPageData } from "@/lib/api/services";
import { readSearchParam } from "@/lib/store-selection";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function MappingsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const data = await getMappingsPageData({
    storeId: readSearchParam(resolvedSearchParams.storeId),
  });
  return <MappingsView data={data} />;
}

import { StoreSettingsView } from "@/components/stores/store-settings-view";
import { getStoreSettingsPageData } from "@/lib/api/services";
import { readSearchParam } from "@/lib/store-selection";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function StoreSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const data = await getStoreSettingsPageData({
    storeId: readSearchParam(resolvedSearchParams.storeId),
  });

  return <StoreSettingsView data={data} />;
}

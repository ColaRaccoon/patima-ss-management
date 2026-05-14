import { AdUploadsView } from "@/components/ads/ad-uploads-view";
import { getAdUploadsPageData } from "@/lib/api/services";
import { readSearchParam } from "@/lib/store-selection";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AdUploadsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const data = await getAdUploadsPageData({
    storeId: readSearchParam(resolvedSearchParams.storeId),
  });
  return <AdUploadsView data={data} />;
}

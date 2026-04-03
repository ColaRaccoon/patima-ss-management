import { AdUploadsView } from "@/components/ads/ad-uploads-view";
import { getAdUploadsPageData } from "@/lib/api/services";

export default async function AdUploadsPage() {
  const data = await getAdUploadsPageData();
  return <AdUploadsView data={data} />;
}

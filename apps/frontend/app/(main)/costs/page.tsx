import { CostsView } from "@/components/costs/costs-view";
import { getCostsPageData } from "@/lib/api/services";

export default async function CostsPage() {
  const data = await getCostsPageData();
  return <CostsView data={data} />;
}

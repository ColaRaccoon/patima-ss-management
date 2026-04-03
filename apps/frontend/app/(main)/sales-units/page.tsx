import { SalesUnitsView } from "@/components/sales-units/sales-units-view";
import { getSalesUnitsPageData } from "@/lib/api/services";

export default async function SalesUnitsPage() {
  const data = await getSalesUnitsPageData();

  return <SalesUnitsView data={data} />;
}

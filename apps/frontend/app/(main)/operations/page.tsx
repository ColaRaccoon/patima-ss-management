import { OperationsView } from "@/components/operations/operations-view";
import { getOperationsPageData } from "@/lib/api/services";

export default async function OperationsPage() {
  const data = await getOperationsPageData();
  return <OperationsView data={data} />;
}

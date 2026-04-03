import { DashboardView } from "@/components/dashboard/dashboard-view";
import { getDashboardPageData } from "@/lib/api/services";

export default async function DashboardPage() {
  const data = await getDashboardPageData();

  return <DashboardView data={data} />;
}

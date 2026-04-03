import { ProfitsView } from "@/components/profits/profits-view";
import { getProfitsPageData } from "@/lib/api/services";

export default async function ProfitsPage() {
  const data = await getProfitsPageData();
  return <ProfitsView data={data} />;
}

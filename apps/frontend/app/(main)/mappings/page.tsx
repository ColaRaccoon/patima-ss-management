import { MappingsView } from "@/components/mappings/mappings-view";
import { getMappingsPageData } from "@/lib/api/services";

export default async function MappingsPage() {
  const data = await getMappingsPageData();
  return <MappingsView data={data} />;
}

import { StoreSettingsView } from "@/components/stores/store-settings-view";
import { getStoreSettingsPageData } from "@/lib/api/services";

export default async function StoreSettingsPage() {
  const data = await getStoreSettingsPageData();

  return <StoreSettingsView data={data} />;
}

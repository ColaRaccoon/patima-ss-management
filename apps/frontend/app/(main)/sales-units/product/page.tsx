import { redirect } from "next/navigation";
import { EmptyState } from "@/components/shared/empty-state";
import { ProductStatusView } from "@/components/sales-units/product-status-view";
import { getShellData } from "@/lib/api/services";
import { buildHrefWithStore, readSearchParam, resolveSelectedStore } from "@/lib/store-selection";

export default async function ProductStatusPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = (await searchParams) ?? {};
  const shell = await getShellData();
  const requestedStoreId = readSearchParam(query.storeId);
  const store = resolveSelectedStore(shell.stores, requestedStoreId);
  if (!store || shell.storeSource !== "live" || (requestedStoreId && store.id !== requestedStoreId)) {
    return <EmptyState title="스토어 연결을 확인해 주세요" description="연결된 스토어의 상품만 조회할 수 있습니다." actionHref="/settings/stores" actionLabel="스토어 설정" />;
  }
  const salesUnitId = readSearchParam(query.salesUnitId);
  if (!salesUnitId) redirect(buildHrefWithStore("/sales-units", null, store.id));
  const date = readSearchParam(query.date);
  return (
    <ProductStatusView
      key={store.id + ":" + salesUnitId + ":" + (date ?? "")}
      store={store}
      salesUnitId={salesUnitId}
      initialDate={date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : shell.today}
      recalculationPending={readSearchParam(query.recalculation) === "pending"}
    />
  );
}

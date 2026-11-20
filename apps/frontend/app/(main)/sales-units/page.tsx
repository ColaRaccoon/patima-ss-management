import { SalesUnitsView } from "@/components/sales-units/sales-units-view";
import { getSalesUnitsPageData, nowInSeoul } from "@/lib/api/services";
import { readSearchParam } from "@/lib/store-selection";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function SalesUnitsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const storeId = readSearchParam(resolvedSearchParams.storeId);
  const data = await getSalesUnitsPageData({ storeId });
  const signatureIds = [...new Set([resolvedSearchParams.signatureId ?? []].flat().filter(Boolean))];
  const orderContextError = signatureIds.length > 100
    ? "한 번에 주문 조합 100개까지 연결할 수 있습니다."
    : signatureIds.length > 0 && storeId !== data.primaryStore?.id
      ? "선택한 주문의 스토어를 확인할 수 없습니다."
      : undefined;

  return (
    <SalesUnitsView
      key={data.primaryStore?.id}
      data={data}
      today={data.costCoverage?.date ?? nowInSeoul()}
      openRegistration={readSearchParam(resolvedSearchParams.register) === "1" || signatureIds.length > 0}
      signatureIds={orderContextError ? [] : signatureIds}
      orderContextError={orderContextError}
    />
  );
}

import { OrdersView } from "@/components/orders/orders-view";
import { getOrdersPageData } from "@/lib/api/services";
import { readSearchParam } from "@/lib/store-selection";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const data = await getOrdersPageData({
    storeId: readSearchParam(resolvedSearchParams.storeId),
    dateFrom: readSearchParam(resolvedSearchParams.dateFrom),
    dateTo: readSearchParam(resolvedSearchParams.dateTo),
    productName: readSearchParam(resolvedSearchParams.productName),
    optionInfo: readSearchParam(resolvedSearchParams.optionInfo),
    mappingStatus: readSearchParam(resolvedSearchParams.mappingStatus) as
      | "ALL"
      | "MAPPED"
      | "UNMAPPED"
      | undefined,
    saleStatus: readSearchParam(resolvedSearchParams.saleStatus),
    orderStatus: readSearchParam(resolvedSearchParams.orderStatus),
    paymentDateStatus: readSearchParam(
      resolvedSearchParams.paymentDateStatus,
    ) as "ALL" | "PRESENT" | "MISSING" | undefined,
  });

  return <OrdersView data={data} />;
}

import { ProfitsView } from "@/components/profits/profits-view";
import { getProfitsPageData } from "@/lib/api/services";
import { readSearchParam } from "@/lib/store-selection";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProfitsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const dateParam = readSearchParam(resolvedSearchParams.date);
  const dateFromParam = readSearchParam(resolvedSearchParams.dateFrom);
  const dateToParam = readSearchParam(resolvedSearchParams.dateTo);
  const selectedDate =
    dateParam ??
    (dateFromParam && dateToParam && dateFromParam === dateToParam
      ? dateFromParam
      : dateToParam ?? dateFromParam);

  const data = await getProfitsPageData({
    storeId: readSearchParam(resolvedSearchParams.storeId),
    dateFrom: selectedDate,
    dateTo: selectedDate,
  });
  return <ProfitsView data={data} />;
}

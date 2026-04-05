import { ProfitsView } from "@/components/profits/profits-view";
import { getProfitsPageData } from "@/lib/api/services";

type SearchParams = Record<string, string | string[] | undefined>;

const readSearchParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

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
    dateFrom: selectedDate,
    dateTo: selectedDate,
  });
  return <ProfitsView data={data} />;
}

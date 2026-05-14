import { buildUpstreamEndpoint } from "@/lib/api/upstream";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");
  const canonicalSalesUnitId = searchParams.get("canonicalSalesUnitId");

  if (!storeId || !dateFrom || !dateTo) {
    return new Response(JSON.stringify({ success: false, message: "storeId, dateFrom, dateTo가 필요합니다." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const query = new URLSearchParams({ storeId, dateFrom, dateTo });
  if (canonicalSalesUnitId) {
    query.set("canonicalSalesUnitId", canonicalSalesUnitId);
  }

  const response = await fetch(buildUpstreamEndpoint(`/profits/daily-sales-units/export?${query.toString()}`), {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    return new Response(JSON.stringify({ success: false, message: "손익 엑셀 다운로드에 실패했습니다.", error: text }), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const buffer = await response.arrayBuffer();
  const filename = `profit-daily-rows-${storeId}-${dateFrom}-${dateTo}.xlsx`;

  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

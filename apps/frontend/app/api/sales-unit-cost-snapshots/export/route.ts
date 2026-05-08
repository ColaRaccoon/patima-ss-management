import { buildUpstreamEndpoint } from "@/lib/api/upstream";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId");
  const effectiveFrom = searchParams.get("effectiveFrom");

  if (!storeId) {
    return new Response(JSON.stringify({ success: false, message: "storeId이 필요합니다." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const query = new URLSearchParams({ storeId });
  if (effectiveFrom) {
    query.append("effectiveFrom", effectiveFrom);
  }

  const response = await fetch(buildUpstreamEndpoint(`/sales-unit-cost-snapshots/export?${query.toString()}`), {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    return new Response(JSON.stringify({ success: false, message: "엑셀 다운로드에 실패했습니다.", error: text }), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const buffer = await response.arrayBuffer();
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const filename = `cost-snapshot-${storeId}-${effectiveFrom || dateStr}.xlsx`;

  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

import { buildUpstreamEndpoint } from "@/lib/api/upstream";

const formatCompactDate = (date: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    return date.replace(/\D/g, "").slice(-6) || date;
  }

  return `${match[1].slice(2)}${match[2]}${match[3]}`;
};

const sanitizeFilenamePart = (value: string | null, fallback: string) => {
  const sanitized = (value ?? fallback)
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ");

  return sanitized || fallback;
};

const buildContentDisposition = (filename: string) => {
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId");
  const storeName = searchParams.get("storeName");
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
  const filename = `${formatCompactDate(dateTo)}_${sanitizeFilenamePart(storeName, storeId)}_성과.xlsx`;

  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": buildContentDisposition(filename),
    },
  });
}

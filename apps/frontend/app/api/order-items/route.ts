import { proxyUpstream, withUpstreamQuery } from "@/lib/api/route-proxy";

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;

  return proxyUpstream({
    path: withUpstreamQuery("/order-items", searchParams),
    fallbackMessage: "Failed to load order items.",
  });
}

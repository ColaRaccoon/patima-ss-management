import { NextResponse } from "next/server";
import {
  buildUpstreamEndpoint,
  extractUpstreamMessage,
  readUpstreamPayload,
} from "@/lib/api/upstream";

interface ProxyUpstreamParams {
  path: string;
  method?: string;
  body?: BodyInit | null;
  headers?: HeadersInit;
  fallbackMessage: string;
}

export async function proxyUpstream({
  path,
  method = "GET",
  body,
  headers,
  fallbackMessage,
}: ProxyUpstreamParams) {
  const response = await fetch(buildUpstreamEndpoint(path), {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...headers,
    },
    body,
  });

  const payload = await readUpstreamPayload(response);
  if (!response.ok) {
    return NextResponse.json(
      {
        success: false,
        message: extractUpstreamMessage(payload, fallbackMessage),
      },
      { status: response.status },
    );
  }

  return NextResponse.json(payload);
}

export function withUpstreamQuery(path: string, searchParams: URLSearchParams) {
  const queryString = searchParams.toString();
  return queryString ? `${path}?${queryString}` : path;
}

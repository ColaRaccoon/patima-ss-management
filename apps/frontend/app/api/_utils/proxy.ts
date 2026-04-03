import { NextResponse } from "next/server";
import {
  buildUpstreamEndpoint,
  extractUpstreamMessage,
  readUpstreamPayload,
} from "@/lib/api/upstream";

export async function proxyRequest(params: {
  path: string;
  method: "GET" | "POST" | "PATCH";
  fallbackMessage: string;
  body?: BodyInit | null;
  headers?: HeadersInit;
}) {
  const response = await fetch(buildUpstreamEndpoint(params.path), {
    method: params.method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...params.headers,
    },
    body: params.body,
  });

  const payload = await readUpstreamPayload(response);
  if (!response.ok) {
    return NextResponse.json(
      {
        success: false,
        message: extractUpstreamMessage(payload, params.fallbackMessage),
      },
      { status: response.status },
    );
  }

  return NextResponse.json(payload);
}

import type { ApiEnvelope } from "@/lib/api/types";

const API_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:4000/api/v1";

function buildEndpoint(path: string) {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  return `${API_BASE_URL}${path}`;
}

function extractData<T>(payload: unknown): T {
  if (
    payload &&
    typeof payload === "object" &&
    "success" in payload &&
    "data" in payload
  ) {
    const success = Reflect.get(payload, "success");
    if (success === false) {
      const message = Reflect.get(payload, "message");
      throw new Error(typeof message === "string" ? message : "API 요청 실패");
    }

    return Reflect.get(payload, "data") as T;
  }

  return payload as T;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "알 수 없는 네트워크 오류";
}

export async function fetchApi<T>(params: {
  label: string;
  path: string;
  fallback?: T;
}): Promise<ApiEnvelope<T>> {
  const endpoint = buildEndpoint(params.path);

  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(2500),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const data = extractData<T>(payload);

    return {
      label: params.label,
      data,
      source: "live",
      endpoint,
    };
  } catch (error) {
    if (!("fallback" in params)) {
      throw new Error(`${params.label}: ${toErrorMessage(error)}`);
    }

    return {
      label: params.label,
      data: params.fallback as T,
      source: "mock",
      endpoint,
      error: toErrorMessage(error),
    };
  }
}

export function withQuery(
  path: string,
  query: Record<string, string | number | boolean | null | undefined>,
) {
  const searchParams = new URLSearchParams();

  Object.entries(query).forEach(([key, value]) => {
    if (value == null || value === "") {
      return;
    }

    searchParams.set(key, String(value));
  });

  const queryString = searchParams.toString();
  return queryString ? `${path}?${queryString}` : path;
}

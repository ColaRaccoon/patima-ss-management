const API_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:4000/api/v1";

export function buildUpstreamEndpoint(path: string) {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  return `${API_BASE_URL}${path}`;
}

export async function readUpstreamPayload(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

export function extractUpstreamMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const message = Reflect.get(payload, "message");
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return fallback;
}

export async function readApiResponse<T>(
  response: Response,
  fallbackMessage: string,
): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | { success?: boolean; data?: T; message?: string }
    | T
    | null;

  if (!response.ok) {
    if (
      payload &&
      typeof payload === "object" &&
      "message" in payload &&
      typeof payload.message === "string" &&
      payload.message.trim()
    ) {
      throw new Error(payload.message);
    }
    throw new Error(fallbackMessage);
  }

  if (payload && typeof payload === "object" && "data" in payload) {
    return payload.data as T;
  }

  return payload as T;
}

export async function requestBrowserApi<T>(
  input: string,
  init: RequestInit,
  fallbackMessage: string,
): Promise<T> {
  return readApiResponse<T>(await fetch(input, init), fallbackMessage);
}

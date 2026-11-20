import { redirect } from "next/navigation";

export default async function LegacyProductRegistrationPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams({ register: "1" });
  for (const [key, values] of Object.entries((await searchParams) ?? {})) {
    if (key !== "storeId" && key !== "signatureId") continue;
    for (const value of [values ?? []].flat()) query.append(key, value);
  }
  redirect("/sales-units?" + query);
}

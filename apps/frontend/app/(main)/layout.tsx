import { AppShell } from "@/components/layout/app-shell";
import { getShellData } from "@/lib/api/services";

export default async function MainLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const shellData = await getShellData();

  return <AppShell shellData={shellData}>{children}</AppShell>;
}

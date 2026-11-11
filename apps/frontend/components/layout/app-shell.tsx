import { SidebarNav } from "@/components/layout/sidebar-nav";
import { Suspense } from "react";
import { TopHeader } from "@/components/layout/top-header";
import type { ShellData } from "@/lib/api/types";
import {
  OrderSyncProvider,
  OrderSyncIndicator,
} from "@/components/orders/order-sync-provider";

interface AppShellProps {
  children: React.ReactNode;
  shellData: ShellData;
}

export function AppShell({ children, shellData }: AppShellProps) {
  return (
    <OrderSyncProvider>
      <a href="#main-content" className="skip-link">본문으로 건너뛰기</a>
      <div className="min-h-screen lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
        <Suspense fallback={<aside className="bg-ink" />}>
          <SidebarNav />
        </Suspense>
        <div className="min-w-0">
          <Suspense fallback={null}>
            <TopHeader shellData={shellData} />
          </Suspense>
          <OrderSyncIndicator />
          <main id="main-content" tabIndex={-1} className="px-4 pb-10 pt-4 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">{children}</div>
          </main>
        </div>
      </div>
    </OrderSyncProvider>
  );
}

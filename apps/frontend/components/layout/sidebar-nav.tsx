"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Boxes,
  FileClock,
  FolderSync,
  LayoutDashboard,
  Map,
  Receipt,
  Settings2,
  Store,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/cn";

const navItems = [
  { href: "/", label: "대시보드", icon: LayoutDashboard },
  { href: "/settings/stores", label: "스토어 설정", icon: Store },
  { href: "/orders", label: "주문 데이터", icon: Receipt },
  { href: "/sales-units", label: "표준 판매단위", icon: Boxes },
  { href: "/mappings", label: "매핑 관리", icon: Map },
  { href: "/ads/uploads", label: "광고 업로드", icon: Upload },
  { href: "/costs", label: "비용 설정", icon: Settings2 },
  { href: "/profits", label: "손익 분석", icon: BarChart3 },
  { href: "/operations", label: "작업 이력", icon: FileClock },
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <aside className="border-b border-ink/10 bg-ink text-white lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r lg:border-r-white/10">
      <div className="flex h-full flex-col px-4 py-5 sm:px-6">
        <div className="mb-6 flex items-center gap-3 rounded-3xl border border-white/10 bg-white/5 px-4 py-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-coral/20 text-coral">
            <FolderSync className="h-6 w-6" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-white/55">
              Internal Console
            </p>
            <h1 className="mt-1 text-lg font-semibold">Patima Naver SS</h1>
          </div>
        </div>

        <nav className="space-y-1">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active =
              href === "/" ? pathname === href : pathname.startsWith(href);

            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition",
                  active
                    ? "bg-white text-ink shadow-lg shadow-black/10"
                    : "text-white/72 hover:bg-white/8 hover:text-white",
                )}
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto rounded-3xl border border-white/10 bg-white/5 p-4">
          <p className="text-xs uppercase tracking-[0.24em] text-white/45">
            MVP Principle
          </p>
          <p className="mt-3 text-sm leading-6 text-white/72">
            조회보다 일관성, 자동화보다 수동 확정, 저장보다 재현 가능성을
            우선하는 운영 툴 UI입니다.
          </p>
        </div>
      </div>
    </aside>
  );
}

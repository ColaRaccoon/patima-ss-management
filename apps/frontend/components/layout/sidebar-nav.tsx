"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  BarChart3,
  Boxes,
  FileClock,
  FolderSync,
  LayoutDashboard,
  Map,
  Menu,
  Receipt,
  Settings2,
  Store,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { buildHrefWithStore, STORE_ID_QUERY_KEY } from "@/lib/store-selection";

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
  const searchParams = useSearchParams();
  const selectedStoreId = searchParams.get(STORE_ID_QUERY_KEY);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setIsMenuOpen(false);
  }, [pathname, selectedStoreId]);
  const hrefWithStore = (href: string) =>
    buildHrefWithStore(href, null, selectedStoreId);

  return (
    <aside
      className="border-b border-ink/10 bg-ink text-white lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:border-b-0 lg:border-r lg:border-r-white/10"
      onKeyDown={(event) => {
        if (event.key === "Escape" && isMenuOpen) {
          setIsMenuOpen(false);
          menuButton.current?.focus();
        }
      }}
    >
      <div className="flex h-full flex-col px-4 py-3 lg:py-5">
        <div className="flex items-center justify-between gap-3 lg:mb-6 lg:px-2">
          <Link href={hrefWithStore("/")} onClick={() => setIsMenuOpen(false)} className="flex min-w-0 items-center gap-2 rounded-lg py-2 font-semibold">
            <FolderSync aria-hidden="true" className="h-5 w-5 shrink-0 text-coral" />
            <span>Patima Naver SS</span>
          </Link>
          <button
            ref={menuButton}
            type="button"
            aria-expanded={isMenuOpen}
            aria-controls="primary-navigation"
            aria-label={isMenuOpen ? "메뉴 닫기" : "메뉴 열기"}
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/20 lg:hidden"
            onClick={() => setIsMenuOpen((current) => !current)}
          >
            {isMenuOpen ? <X aria-hidden="true" className="h-5 w-5" /> : <Menu aria-hidden="true" className="h-5 w-5" />}
          </button>
        </div>

        <nav id="primary-navigation" aria-label="주요 메뉴" className={cn("mt-3 gap-1 sm:grid-cols-3 lg:mt-0 lg:flex lg:flex-col", isMenuOpen ? "grid grid-cols-2" : "hidden")}>
          {navItems.map(({ href, label, icon: Icon }) => {
            const active =
              href === "/" ? pathname === href : pathname.startsWith(href);

            return (
              <Link
                key={href}
                href={hrefWithStore(href)}
                aria-current={active ? "page" : undefined}
                onClick={() => setIsMenuOpen(false)}
                className={cn(
                  "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition",
                  active
                    ? "bg-white text-ink shadow-lg shadow-black/10"
                    : "text-white/72 hover:bg-white/8 hover:text-white",
                )}
              >
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

      </div>
    </aside>
  );
}

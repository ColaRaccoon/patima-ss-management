import type { Metadata } from "next";
import "@/app/globals.css";

export const metadata: Metadata = {
  title: "Patima SmartStore Console",
  description: "스마트스토어 손익 관리 내부 운영 도구",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="app-shell-noise">{children}</body>
    </html>
  );
}

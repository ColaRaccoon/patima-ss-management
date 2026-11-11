import type { SourceState } from "@/lib/api/types";

interface SourceBannerProps {
  sources: SourceState[];
}

export function SourceBanner({ sources }: SourceBannerProps) {
  const mockSources = sources.filter((source) => source.source === "mock");
  if (mockSources.length === 0) return null;

  return (
    <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-semibold">샘플 데이터가 표시되고 있습니다</p>
      <p className="mt-1 leading-6">
        일부 정보를 불러오지 못해 예시 값으로 표시했습니다. 서버 연결을 확인한 뒤 다시 조회해 주세요.
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer font-medium">연결 오류 자세히 보기</summary>
        <ul className="mt-2 space-y-1 break-words text-xs leading-5">
          {mockSources.map((source, index) => (
            <li key={`${source.label}-${index}`}>
              {source.label}: {source.error ?? "요청 실패"}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
